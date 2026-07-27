use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

#[cfg(not(target_os = "windows"))]
const BASH_PROMPT_COMMAND: &str = concat!(
    r#"__ait_ec=$?; "#,
    // Finder provides GUI apps with a minimal PATH. Run macOS path_helper once
    // so Intel/Bash installations in /usr/local/bin are available immediately.
    r#"if [ -z "${__ait_path_ready:-}" ]; then __ait_path_ready=1; [ ! -x /usr/libexec/path_helper ] || eval "$(/usr/libexec/path_helper -s)"; fi; "#,
    r#"printf '\e]133;D;%s\a' "$__ait_ec"; printf '\e]7;file://%s%s\a' "$(hostname)" "$(pwd)"; printf '\e]133;A\a'"#,
);

#[cfg(not(target_os = "windows"))]
fn bash_prompt_command(existing: Option<&str>) -> String {
    match existing
        .map(str::trim)
        .filter(|command| !command.is_empty())
    {
        // Do not carry a prompt hook inherited from another AI Terminal shell.
        // In particular, older releases embedded `${PROMPT_COMMAND:-:}` in the
        // value itself, which expands recursively on Bash 3.2 and is then
        // treated as a command name.
        Some(command) if !command.contains("__ait_ec") => {
            format!("{};{}", BASH_PROMPT_COMMAND, command)
        }
        _ => BASH_PROMPT_COMMAND.to_string(),
    }
}

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

        // PowerShell: disable PSReadLine prediction (PTY cursor issue) +
        // install custom prompt that emits OSC 7 (cwd) and OSC 133 A/B/D markers.
        if is_powershell {
            let ps_init = r#"& { try { Set-PSReadLineOption -PredictionSource None } catch {}; try { Set-PSReadLineOption -ExtraPromptLineCount 0 } catch {}; function global:Prompt { $ec = if ($?) { 0 } else { 1 }; $esc = [char]27; $bel = [char]7; [Console]::Write("$esc]133;D;$ec$bel"); [Console]::Write("$esc]7;file://$env:COMPUTERNAME$((Get-Location).Path -replace '\\','/')$bel"); [Console]::Write("$esc]133;A$bel"); $p = "$((Get-Location).Path)> "; [Console]::Write("$esc]133;B$bel"); return $p } }"#;
            cmd.args(["-NoLogo", "-NoExit", "-Command", ps_init]);
        }

        // For cmd.exe: set custom prompt to show full cwd (e.g., "C:\path>")
        if is_cmd {
            // Replace default args with custom prompt
            cmd = CommandBuilder::new(&shell);
            cmd.args(["/K", "prompt $P$G"]);
        }

        if let Some(ref dir) = cwd {
            // Only use saved cwd if the directory actually exists
            if std::path::Path::new(dir).is_dir() {
                cmd.cwd(dir);
            } else {
                if let Some(home) = dirs_next_home() {
                    cmd.cwd(home);
                }
            }
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

        // Inject OSC 7 (cwd) + OSC 133 (shell integration) hooks.
        // OSC 133: A=prompt start, B=prompt end, C=preexec, D=command done (+exit).
        #[cfg(not(target_os = "windows"))]
        {
            let is_zsh = shell_lower.contains("zsh");
            let is_bash = shell_lower.contains("bash");
            if is_zsh {
                let tmp_dir = std::env::temp_dir().join(format!("ait-zsh-{}", tab_id.replace('-', "")));
                let _ = std::fs::create_dir_all(&tmp_dir);
                let user_home = std::env::var("HOME").unwrap_or_default();
                let zshrc_content = format!(
                    r#"# AI Terminal: complete system PATH, source user config, then install integration hooks
# Non-login shells skip /etc/zprofile, so path_helper never runs and PATH is
# left at launchd's minimal default (e.g. when the app is started from Finder).
# Run it ourselves BEFORE user config so ~/.zshrc still has the final say on order.
if [[ -x /usr/libexec/path_helper ]]; then
  eval "$(/usr/libexec/path_helper -s)"
fi
if [[ -f "{home}/.zshrc" ]]; then
  ZDOTDIR="{home}" source "{home}/.zshrc"
fi
__ait_osc7() {{ printf '\e]7;file://%s%s\a' "$(hostname)" "$(pwd)"; }}
__ait_precmd() {{
  local ec=$?
  printf '\e]133;D;%s\a' "$ec"
  __ait_osc7
  printf '\e]133;A\a'
}}
__ait_preexec() {{ printf '\e]133;C\a'; }}
# Mark prompt end by appending OSC 133 B to PS1 (only once)
if [[ "$PS1" != *$'\e]133;B'* ]]; then
  PS1="%{{$(printf '\e]133;B\a')%}}$PS1"
fi
autoload -Uz add-zsh-hook 2>/dev/null
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook chpwd __ait_osc7
  add-zsh-hook precmd __ait_precmd
  add-zsh-hook preexec __ait_preexec
else
  chpwd_functions=(__ait_osc7 ${{chpwd_functions[@]}})
  precmd_functions=(__ait_precmd ${{precmd_functions[@]}})
  preexec_functions=(__ait_preexec ${{preexec_functions[@]}})
fi
ZDOTDIR="{home}"
"#,
                    home = user_home
                );
                let _ = std::fs::write(tmp_dir.join(".zshrc"), &zshrc_content);
                let zshenv_content = format!(
                    r#"if [[ -f "{home}/.zshenv" ]]; then source "{home}/.zshenv"; fi
"#,
                    home = user_home
                );
                let _ = std::fs::write(tmp_dir.join(".zshenv"), &zshenv_content);
                cmd.env("ZDOTDIR", tmp_dir.to_str().unwrap_or("/tmp"));
            } else if is_bash {
                // Bash 3.2 (the system Bash on older/Intel Macs) evaluates
                // PROMPT_COMMAND as shell source. Compose the inherited value
                // here instead of putting a self-reference in that value.
                let inherited = std::env::var("PROMPT_COMMAND").ok();
                cmd.env("PROMPT_COMMAND", bash_prompt_command(inherited.as_deref()));
                // Prepend OSC 133 B to PS1 via BASH_ENV-like approach: set through env is messy,
                // so rely on consumers treating prompt-end as implicit before user input.
            }
        }


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
            .insert(tab_id.clone(), Arc::new(Mutex::new(instance)));

        // Note: OSC 7 hook is injected via ZDOTDIR (zsh) or PROMPT_COMMAND (bash)
        // in the environment setup above — no delayed write needed

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

    #[allow(dead_code)]
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

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::{bash_prompt_command, BASH_PROMPT_COMMAND};

    #[test]
    fn bash_prompt_command_has_no_recursive_self_reference() {
        let command = bash_prompt_command(None);
        assert_eq!(command, BASH_PROMPT_COMMAND);
        assert!(!command.contains("PROMPT_COMMAND"));
        assert!(command.contains("/usr/libexec/path_helper"));
    }

    #[test]
    fn bash_prompt_command_preserves_an_inherited_hook() {
        let command = bash_prompt_command(Some("history -a"));
        assert_eq!(command, format!("{};history -a", BASH_PROMPT_COMMAND));
    }

    #[test]
    fn bash_prompt_command_replaces_an_old_ai_terminal_hook() {
        let old = "__ait_ec=$?; ${PROMPT_COMMAND:-:}";
        assert_eq!(bash_prompt_command(Some(old)), BASH_PROMPT_COMMAND);
    }
}
