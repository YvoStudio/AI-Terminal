use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

pub struct PtyInstance {
    writer: Box<dyn Write + Send>,
    pair: PtyPair,
    #[allow(dead_code)]
    child: Box<dyn portable_pty::Child + Send>,
}

pub struct PtyManager {
    instances: HashMap<String, Arc<Mutex<PtyInstance>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            instances: HashMap::new(),
        }
    }

    pub fn create(
        &mut self,
        tab_id: String,
        cwd: Option<String>,
        on_data: impl Fn(String) + Send + 'static,
    ) -> Result<(), String> {
        self.create_with_shell(tab_id, cwd, Self::default_shell(), on_data)
    }

    pub fn create_with_shell(
        &mut self,
        tab_id: String,
        cwd: Option<String>,
        shell: String,
        on_data: impl Fn(String) + Send + 'static,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();

        let size = PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open pty: {}", e))?;

        let shell_lower = shell.to_lowercase();
        let is_powershell = shell_lower.contains("powershell") || shell_lower.contains("pwsh");

        let mut cmd = CommandBuilder::new(&shell);

        // For PowerShell: disable PSReadLine features that cause cursor to
        // render in wrong position inside PTY terminals.
        // Use try/catch because -ErrorAction doesn't catch parameter binding errors.
        if is_powershell {
            cmd.args([
                "-NoLogo",
                "-NoExit",
                "-Command",
                "& { try { Set-PSReadLineOption -PredictionSource None } catch {}; try { Set-PSReadLineOption -ExtraPromptLineCount 0 } catch {} }",
            ]);
        }

        if let Some(ref dir) = cwd {
            cmd.cwd(dir);
        } else {
            if let Some(home) = dirs_next_home() {
                cmd.cwd(home);
            }
        }

        // Set environment
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("LC_ALL", "en_US.UTF-8");
        // Prevent Claude Code from refusing to start inside this terminal
        cmd.env_remove("CLAUDECODE");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn: {}", e))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        // Spawn reader thread
        let tab_id_clone = tab_id.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        on_data(data);
                    }
                    Err(_) => break,
                }
            }
            let _ = tab_id_clone;
        });

        let instance = PtyInstance {
            writer,
            pair,
            child,
        };

        self.instances
            .insert(tab_id, Arc::new(Mutex::new(instance)));

        Ok(())
    }

    pub fn write(&self, tab_id: &str, data: &str) -> Result<(), String> {
        if let Some(instance) = self.instances.get(tab_id) {
            let mut inst = instance.lock().map_err(|e| e.to_string())?;
            inst.writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("Write failed: {}", e))?;
            inst.writer.flush().map_err(|e| format!("Flush failed: {}", e))?;
            Ok(())
        } else {
            Err("Tab not found".into())
        }
    }

    pub fn resize(&self, tab_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if let Some(instance) = self.instances.get(tab_id) {
            let inst = instance.lock().map_err(|e| e.to_string())?;
            inst.pair
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("Resize failed: {}", e))?;
            Ok(())
        } else {
            Err("Tab not found".into())
        }
    }

    pub fn close(&mut self, tab_id: &str) {
        self.instances.remove(tab_id);
    }

    pub fn get_cwd(&self, tab_id: &str) -> String {
        if let Some(instance) = self.instances.get(tab_id) {
            if let Ok(inst) = instance.lock() {
                if let Ok(pid) = inst.child.process_id().ok_or("no pid") {
                    return get_process_cwd(pid as u32);
                }
            }
        }
        home_dir()
    }

    pub fn destroy_all(&mut self) {
        self.instances.clear();
    }

    fn default_shell() -> String {
        #[cfg(target_os = "windows")]
        {
            std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
        }
    }
}

fn home_dir() -> String {
    #[cfg(target_os = "windows")]
    { std::env::var("USERPROFILE").unwrap_or_default() }
    #[cfg(not(target_os = "windows"))]
    { std::env::var("HOME").unwrap_or_default() }
}

fn dirs_next_home() -> Option<String> {
    let h = home_dir();
    if h.is_empty() { None } else { Some(h) }
}

#[allow(unused_variables)]
fn get_process_cwd(pid: u32) -> String {
    #[cfg(target_os = "linux")]
    {
        let path = format!("/proc/{}/cwd", pid);
        std::fs::read_link(&path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| home_dir())
    }
    #[cfg(target_os = "macos")]
    {
        // Use lsof on macOS
        let output = std::process::Command::new("lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output();
        if let Ok(out) = output {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().find(|l| l.starts_with('n')) {
                return line[1..].to_string();
            }
        }
        home_dir()
    }
    #[cfg(target_os = "windows")]
    {
        // On Windows, return home as fallback (QueryFullProcessImageName requires handle)
        home_dir()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        home_dir()
    }
}
