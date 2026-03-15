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
    cwd: String,
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
        let is_cmd = shell_lower == "cmd.exe" || shell_lower == "cmd";

        let mut cmd = CommandBuilder::new(&shell);

        // For PowerShell: disable PSReadLine features that cause cursor to
        // render in wrong position inside PTY terminals.
        // Also set custom prompt to show full cwd for path tracking.
        if is_powershell {
            cmd.args([
                "-NoLogo",
                "-NoExit",
                "-Command",
                "& { try { Set-PSReadLineOption -PredictionSource None } catch {}; try { Set-PSReadLineOption -ExtraPromptLineCount 0 } catch {}; function Prompt { '$(Get-Location)> ' } }",
            ]);
        }

        // For cmd.exe: set custom prompt to show full cwd (e.g., "C:\path>")
        if is_cmd {
            // Replace default args with custom prompt
            cmd = CommandBuilder::new(&shell);
            cmd.args(["/K", "prompt $P$G"]);
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
        // Disable mouse tracking protocols - prevent mouse events from being sent to PTY
        cmd.env("XTERM_VERSION", "XTerm(396)");
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
            let mut pending = Vec::new(); // incomplete UTF-8 bytes from previous read
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        // Find the last valid UTF-8 boundary
                        match std::str::from_utf8(&pending) {
                            Ok(s) => {
                                on_data(s.to_string());
                                pending.clear();
                            }
                            Err(e) => {
                                let valid_up_to = e.valid_up_to();
                                if valid_up_to > 0 {
                                    let valid =
                                        std::str::from_utf8(&pending[..valid_up_to]).unwrap();
                                    on_data(valid.to_string());
                                    pending = pending[valid_up_to..].to_vec();
                                }
                                // Keep remaining bytes for next read (incomplete char)
                                // But if pending is too large (>8 bytes), it's truly invalid — flush it
                                if pending.len() > 8 {
                                    let data = String::from_utf8_lossy(&pending).to_string();
                                    on_data(data);
                                    pending.clear();
                                }
                            }
                        }
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
            cwd: cwd.unwrap_or_else(|| dirs_next_home().unwrap_or_default()),
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
            inst.writer
                .flush()
                .map_err(|e| format!("Flush failed: {}", e))?;
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
                return inst.cwd.clone();
            }
        }
        home_dir()
    }

    /// Update cwd for a tab (called from output_parser when cwd changes)
    pub fn update_cwd(&self, tab_id: &str, new_cwd: String) {
        if let Some(instance) = self.instances.get(tab_id) {
            if let Ok(mut inst) = instance.lock() {
                inst.cwd = new_cwd;
            }
        }
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
    {
        std::env::var("USERPROFILE").unwrap_or_default()
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").unwrap_or_default()
    }
}

fn dirs_next_home() -> Option<String> {
    let h = home_dir();
    if h.is_empty() {
        None
    } else {
        Some(h)
    }
}
