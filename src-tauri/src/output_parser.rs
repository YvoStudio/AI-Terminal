use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TabStatus {
    Active,
    Executing,
    DoneUnseen,
    Waiting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarEntry {
    #[serde(rename = "type")]
    pub entry_type: String,
    pub timestamp: u64,
    pub content: String,
}

struct TabState {
    entries: Vec<SidebarEntry>,
    buffer: String,
    mute_until: u64,
    is_active: bool,
    was_executing: bool,
    user_input_count: u32,
    auto_renamed: bool,
    ai_tool: Option<String>,
    cwd: String,
    last_output_ms: u64,
    last_input_ms: u64,
    last_done_unseen_ms: u64,
}

impl TabState {
    fn new() -> Self {
        Self {
            entries: Vec::new(),
            buffer: String::new(),
            mute_until: 0,
            is_active: false,
            was_executing: false,
            user_input_count: 0,
            auto_renamed: false,
            ai_tool: None,
            cwd: String::new(),
            last_output_ms: 0,
            last_input_ms: 0,
            last_done_unseen_ms: 0,
        }
    }

    fn update_cwd(&mut self, new_cwd: String) {
        self.cwd = new_cwd;
    }
}

pub struct OutputParser {
    states: HashMap<String, TabState>,
}

impl OutputParser {
    pub fn new() -> Self {
        Self {
            states: HashMap::new(),
        }
    }

    pub fn init_tab(&mut self, tab_id: &str) {
        self.states
            .entry(tab_id.to_string())
            .or_insert_with(TabState::new);
    }

    pub fn init_tab_with_cwd(&mut self, tab_id: &str, cwd: &str) {
        let state = self
            .states
            .entry(tab_id.to_string())
            .or_insert_with(TabState::new);
        if !cwd.is_empty() {
            state.cwd = cwd.to_string();
        }
    }

    pub fn remove_tab(&mut self, tab_id: &str) {
        self.states.remove(tab_id);
    }

    pub fn get_entries(&self, tab_id: &str) -> Vec<SidebarEntry> {
        self.states
            .get(tab_id)
            .map(|s| s.entries.clone())
            .unwrap_or_default()
    }

    pub fn process(
        &mut self,
        tab_id: &str,
        raw: &str,
        on_status: impl Fn(String, TabStatus),
        on_entry: impl Fn(String, SidebarEntry),
        on_rename: impl Fn(String, String),
        on_ai_detected: impl Fn(String, String, String),
        on_cwd_changed: impl Fn(String, String),
    ) {
        let state = self
            .states
            .entry(tab_id.to_string())
            .or_insert_with(TabState::new);
        let now = now_ms();
        state.last_output_ms = now;

        // Output-side AI detection (first, so subsequent logic can use ai_tool).
        // Catches Claude / Aider sessions started outside our input tracking
        // (resume, scripts, history-launched tabs). Trigger on UI markers.
        if state.ai_tool.is_none() {
            // ⏺ (U+23FA) and ✻ (U+273B) are Claude Code's distinctive UI glyphs,
            // unlikely to appear in plain shell output. Box-drawing corners + image
            // refs are additional signals.
            if raw.contains('⏺') || raw.contains('✻')
                || raw.contains("╭─") || raw.contains("╰─")
                || raw.contains("[Image #") || raw.contains("? for shortcuts")
            {
                eprintln!("AI detected via output markers in tab {}", tab_id);
                state.ai_tool = Some("claude".to_string());
                on_ai_detected(tab_id.to_string(), state.cwd.clone(), "claude".to_string());
            }
        }

        // For AI tabs, any output chunk means streaming is in progress. The idle-stream
        // watcher (lib.rs) will flip to DoneUnseen after the last chunk.
        // BUT: after we fire DoneUnseen once, refuse to re-arm executing until the user
        // actually inputs something. Otherwise idle UI redraws (cursor blink, time
        // counters) keep retriggering the red dot every couple of seconds.
        if state.ai_tool.is_some() && !state.was_executing {
            let allow = state.last_input_ms >= state.last_done_unseen_ms;
            eprintln!(
                "[exec-gate] tab={} last_input={} last_done={} allow={}",
                tab_id, state.last_input_ms, state.last_done_unseen_ms, allow
            );
            if allow {
                state.was_executing = true;
                on_status(tab_id.to_string(), TabStatus::Executing);
            }
        }

        // Parse OSC 7 (cwd notification) before stripping ANSI
        // Format: \x1b]7;file://hostname/path\x07  or  \x1b]7;file://hostname/path\x1b\\
        if let Some(new_cwd) = extract_osc7_cwd(raw) {
            eprintln!("OSC 7 cwd detected: '{}'", new_cwd);
            if new_cwd != state.cwd {
                state.update_cwd(new_cwd.clone());
                on_cwd_changed(tab_id.to_string(), new_cwd);
            }
        }

        // Parse OSC 133 (shell integration): C = command started, D = command done, A = prompt shown
        for marker in extract_osc133(raw) {
            match marker {
                Osc133::CommandStart => {
                    // Same input-gate as the chunk path: don't let idle redraws that
                    // happen to include OSC 133 C re-arm executing after a done-unseen.
                    if state.last_input_ms >= state.last_done_unseen_ms {
                        state.was_executing = true;
                        on_status(tab_id.to_string(), TabStatus::Executing);
                    }
                }
                Osc133::CommandDone(_exit) => {
                    if state.was_executing {
                        state.was_executing = false;
                        state.last_done_unseen_ms = now;
                        on_status(tab_id.to_string(), TabStatus::DoneUnseen);
                    }
                }
                Osc133::PromptStart => {
                    // If not mid-execution, we're at a fresh prompt → Waiting only makes sense for AI tabs
                    if state.ai_tool.is_some() && !state.was_executing {
                        on_status(tab_id.to_string(), TabStatus::Waiting);
                    }
                }
                Osc133::PromptEnd => {}
            }
        }

        // Parse OSC 0/2 (terminal title) — Claude Code sets this to session name
        // Format: \x1b]0;title\x07  or  \x1b]2;title\x07
        if let Some((title, has_status_prefix)) = extract_osc_title(raw) {
            eprintln!("OSC title detected: '{}'", title);
            if state.ai_tool.is_some() && !title.is_empty() {
                // Only the rename matters here. Claude Code emits the title repeatedly
                // during redraws WITHOUT any status prefix, so we cannot use this to
                // infer streaming state — the idle-stream watcher (lib.rs) handles that.
                if has_status_prefix && state.last_input_ms >= state.last_done_unseen_ms {
                    // Gate re-arming on user input: Claude Code keeps repainting the
                    // title with a spinner prefix even when truly idle. Without this
                    // gate, the idle-stream watcher re-fires DoneUnseen seconds after
                    // the user already saw the tab.
                    state.was_executing = true;
                    on_status(tab_id.to_string(), TabStatus::Executing);
                }
                on_rename(tab_id.to_string(), title);
            }
        }

        // Bell char → done-unseen (but ignore BEL inside OSC sequences)
        let has_standalone_bell = raw.contains('\x07') && {
            // Check if there's a BEL that's NOT part of an OSC sequence terminator
            let mut found = false;
            let bytes = raw.as_bytes();
            for (i, &b) in bytes.iter().enumerate() {
                if b == 0x07 {
                    // Look back to see if this BEL terminates an OSC sequence (\x1b]...)
                    let before = &raw[..i];
                    let is_osc_terminator = before.rfind("\x1b]").map_or(false, |osc_start| {
                        // Check there's no other terminator between OSC start and this BEL
                        !before[osc_start..].contains("\x1b\\")
                    });
                    if !is_osc_terminator {
                        found = true;
                        break;
                    }
                }
            }
            found
        };
        if has_standalone_bell && state.was_executing && state.ai_tool.is_none() {
            // Plain shells: BEL after executing means command finished. AI tabs use
            // the idle-stream watcher (lib.rs) instead — Claude emits BEL for
            // confirmation prompts mid-stream which would falsely flip status.
            state.was_executing = false;
            state.last_done_unseen_ms = now;
            on_status(tab_id.to_string(), TabStatus::DoneUnseen);
        }

        // Skip parsing during resize quiet period
        if now < state.mute_until {
            return;
        }

        let cleaned = strip_ansi(raw);
        state.buffer.push_str(&cleaned);

        let mut lines: Vec<String> = state.buffer.split('\n').map(|s| s.to_string()).collect();
        state.buffer = lines.pop().unwrap_or_default();

        for line in lines {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            // User prompt: ❯ xxx
            if state.ai_tool.is_some() && is_ai_waiting_prompt(trimmed) {
                let next_status = if state.was_executing {
                    state.was_executing = false;
                    state.last_done_unseen_ms = now;
                    TabStatus::DoneUnseen
                } else {
                    TabStatus::Waiting
                };
                on_status(tab_id.to_string(), next_status);
                continue;
            }

            if let Some(content) = match_prompt(trimmed) {
                if content.is_empty() {
                    continue;
                }

                // Check if this is from Windows prompt extraction (format: "cd {path}")
                if content.starts_with("cd ") {
                    // Extract the path part after "cd "
                    let path = &content[3..];
                    eprintln!("Checking path for cwd: '{}', is_windows: {}", path, is_windows_path(path));
                    if is_windows_path(path) {
                        // Direct Windows path from prompt - update cwd, skip user-input entry
                        eprintln!("Updating CWD to: '{}'", path);
                        state.update_cwd(path.to_string());
                        on_cwd_changed(tab_id.to_string(), path.to_string());
                        continue; // Skip adding to sidebar entries
                    } else if let Some(new_cwd) = extract_cd_path(&content, &state.cwd) {
                        // Regular cd command - update cwd, skip user-input entry
                        eprintln!("Updating CWD (cd cmd) to: '{}'", new_cwd);
                        state.update_cwd(new_cwd.clone());
                        on_cwd_changed(tab_id.to_string(), new_cwd);
                        continue; // Skip adding to sidebar entries
                    }
                }

                // Check for Windows drive switch (e.g., "G:", "D:")
                if is_drive_letter(&content) {
                    let new_cwd = format!("{}\\", content.to_uppercase());
                    eprintln!("Updating CWD (drive switch) to: '{}'", new_cwd);
                    state.update_cwd(new_cwd.clone());
                    on_cwd_changed(tab_id.to_string(), new_cwd);
                    continue; // Skip adding to sidebar entries
                }

                // Detect AI launch
                if state.ai_tool.is_none() {
                    if let Some(ai) = is_ai_command(&content) {
                        state.ai_tool = Some(ai.to_string());
                        let cwd = state.cwd.clone();
                        eprintln!("AI detected: {} in tab {} (cwd: {})", ai, tab_id, cwd);
                        on_ai_detected(tab_id.to_string(), cwd, ai.to_string());
                    }
                }

                // Deduplicate
                if let Some(last) = state.entries.last() {
                    if last.entry_type == "user-input" && last.content == content {
                        continue;
                    }
                }

                let entry = SidebarEntry {
                    entry_type: "user-input".to_string(),
                    timestamp: now,
                    content: truncate_str(&content, 200).to_string(),
                };
                state.entries.push(entry.clone());
                on_entry(tab_id.to_string(), entry);
                state.user_input_count += 1;

                // Save to history after 3 interactions (non-AI tabs)
                if state.ai_tool.is_none() && state.user_input_count == 3 {
                    state.ai_tool = Some("shell".to_string());
                    on_ai_detected(tab_id.to_string(), String::new(), "shell".to_string());
                }

                // Auto-rename after 5 inputs
                if state.user_input_count == 5 && !state.auto_renamed {
                    if let Some(name) = generate_tab_name(&state.entries) {
                        state.auto_renamed = true;
                        on_rename(tab_id.to_string(), name);
                    }
                }
                continue;
            }

            // Tool call line
            if is_tool_call(trimmed) {
                let content = truncate_str(trimmed, 200);
                if let Some(last) = state.entries.last() {
                    if last.entry_type == "tool-call" && last.content == content {
                        continue;
                    }
                }
                let entry = SidebarEntry {
                    entry_type: "tool-call".to_string(),
                    timestamp: now,
                    content: content.to_string(),
                };
                state.entries.push(entry.clone());
                on_entry(tab_id.to_string(), entry);
            }
        }

        if state.ai_tool.is_some() && is_ai_waiting_prompt(state.buffer.trim()) {
            let next_status = if state.was_executing {
                state.was_executing = false;
                state.last_done_unseen_ms = now;
                TabStatus::DoneUnseen
            } else {
                TabStatus::Waiting
            };
            on_status(tab_id.to_string(), next_status);
        }
    }

    pub fn mute_tab(&mut self, tab_id: &str, ms: u64) {
        let state = self
            .states
            .entry(tab_id.to_string())
            .or_insert_with(TabState::new);
        state.mute_until = now_ms() + ms;
        state.buffer.clear();
    }

    /// Scan all tabs and return tab_ids whose AI session has been idle long enough
    /// to consider the streaming finished. Caller is responsible for emitting status events.
    pub fn collect_idle_done(&mut self, idle_threshold_ms: u64) -> Vec<String> {
        let now = now_ms();
        let mut done = Vec::new();
        for (tab_id, state) in self.states.iter_mut() {
            if state.was_executing
                && state.ai_tool.is_some()
                && state.last_output_ms > 0
                && now.saturating_sub(state.last_output_ms) >= idle_threshold_ms
            {
                state.was_executing = false;
                state.last_done_unseen_ms = now;
                done.push(tab_id.clone());
            }
        }
        done
    }

    /// Record that the user wrote to this tab's PTY. Used to gate re-arming of
    /// the executing-status (and thus future idle done-unseen events) — without
    /// this, idle UI redraws keep flipping the red dot back on.
    pub fn mark_input(&mut self, tab_id: &str) {
        let state = self.states.entry(tab_id.to_string()).or_insert_with(TabState::new);
        state.last_input_ms = now_ms();
        eprintln!("[mark_input] tab={} now={}", tab_id, state.last_input_ms);
    }
}

/// Extract terminal title from OSC 0 or OSC 2 escape sequence
/// Format: \x1b]0;title\x07  or  \x1b]2;title\x07
fn extract_osc_title(raw: &str) -> Option<(String, bool)> {
    // Try OSC 2 first (set window title), then OSC 0 (set icon name + title)
    for marker in &["\x1b]2;", "\x1b]0;"] {
        if let Some(start) = raw.find(marker) {
            let after = &raw[start + marker.len()..];
            let end = after.find('\x07')
                .or_else(|| after.find("\x1b\\"))?;
            let original = after[..end].trim();
            let has_status_prefix = title_has_status_prefix(original);
            let cleaned = strip_title_status_prefix(original);
            let title = cleaned.as_str();
            if !title.is_empty() && title.len() < 200 && !title.contains('\n') {
                return Some((title.to_string(), has_status_prefix));
            }
        }
    }
    None
}

fn title_has_status_prefix(title: &str) -> bool {
    for ch in title.chars() {
        if ch.is_whitespace() {
            continue;
        }
        return is_status_prefix_char(ch);
    }
    false
}

fn strip_title_status_prefix(title: &str) -> String {
    let mut started = false;
    let mut result = String::new();

    for ch in title.chars() {
        if !started {
            if ch.is_whitespace() {
                continue;
            }

            if is_status_prefix_char(ch) {
                continue;
            }

            started = true;
        }

        result.push(ch);
    }

    result.trim().to_string()
}

fn is_status_prefix_char(ch: char) -> bool {
    matches!(
        ch,
        '*' | '.'
            | '●' | '○'
            | '◆' | '◇'
            | '■' | '□'
            | '✳' | '✻'
            | '•' | '·'
            | '∙' | '⋅'
            | '◉' | '◎'
            | '◌' | '◍'
            | '◐' | '◑'
            | '◒' | '◓'
            | '◴' | '◵'
            | '◶' | '◷'
            | '⠁' | '⠂' | '⠄' | '⠆' | '⠇' | '⠋' | '⠙' | '⠸' | '⠼' | '⠿'
    ) || ('\u{2800}'..='\u{28FF}').contains(&ch)
}

/// OSC 9 (iTerm2 notification): `\e]9;<message>\a` — simple one-line notification.
/// OSC 9;4 (ConEmu progress): `\e]9;4;<state>;<pct>\a` — state 0=clear 1=normal 2=error 3=indet 4=warn.
/// OSC 777 notify (kitty/urxvt): `\e]777;notify;<title>;<body>\a`.
/// Returns (notifications, progress updates).
pub fn extract_notifications_and_progress(raw: &str)
    -> (Vec<(String, String)>, Vec<(u8, u8)>)
{
    let mut notifications = Vec::new();
    let mut progress = Vec::new();
    // OSC 9 and OSC 9;4 share prefix `\e]9;`
    let mut rest = raw;
    let marker9 = "\x1b]9;";
    while let Some(idx) = rest.find(marker9) {
        let after = &rest[idx + marker9.len()..];
        let end = match after.find('\x07').or_else(|| after.find("\x1b\\")) {
            Some(e) => e,
            None => break,
        };
        let payload = &after[..end];
        // OSC 9;4;<state>;<pct>
        if let Some(rest4) = payload.strip_prefix("4;") {
            let mut parts = rest4.split(';');
            let state: u8 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let pct: u8 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            progress.push((state, pct));
        } else if !payload.is_empty() && payload.len() < 500 {
            notifications.push(("AI Terminal".to_string(), payload.to_string()));
        }
        let advance = idx + marker9.len() + end + 1;
        if advance >= rest.len() { break; }
        rest = &rest[advance..];
    }
    // OSC 777;notify;title;body
    let marker777 = "\x1b]777;notify;";
    let mut rest = raw;
    while let Some(idx) = rest.find(marker777) {
        let after = &rest[idx + marker777.len()..];
        let end = match after.find('\x07').or_else(|| after.find("\x1b\\")) {
            Some(e) => e,
            None => break,
        };
        let payload = &after[..end];
        let mut parts = payload.splitn(2, ';');
        let title = parts.next().unwrap_or("AI Terminal").to_string();
        let body = parts.next().unwrap_or("").to_string();
        if !title.is_empty() && title.len() < 200 && body.len() < 500 {
            notifications.push((title, body));
        }
        let advance = idx + marker777.len() + end + 1;
        if advance >= rest.len() { break; }
        rest = &rest[advance..];
    }
    (notifications, progress)
}

#[derive(Debug, Clone, Copy)]
enum Osc133 {
    PromptStart,
    PromptEnd,
    CommandStart,
    CommandDone(i32),
}

/// Find all OSC 133 markers in raw output.
/// Format: \x1b]133;<kind>[;args]<ST>  where ST = BEL (\x07) or \x1b\\
fn extract_osc133(raw: &str) -> Vec<Osc133> {
    let mut out = Vec::new();
    let marker = "\x1b]133;";
    let mut rest = raw;
    while let Some(idx) = rest.find(marker) {
        let after = &rest[idx + marker.len()..];
        let end = match after.find('\x07').or_else(|| after.find("\x1b\\")) {
            Some(e) => e,
            None => break,
        };
        let payload = &after[..end];
        let mut parts = payload.split(';');
        let kind = parts.next().unwrap_or("");
        match kind {
            "A" => out.push(Osc133::PromptStart),
            "B" => out.push(Osc133::PromptEnd),
            "C" => out.push(Osc133::CommandStart),
            "D" => {
                let exit = parts.next().and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
                out.push(Osc133::CommandDone(exit));
            }
            _ => {}
        }
        let advance = idx + marker.len() + end + 1;
        if advance >= rest.len() { break; }
        rest = &rest[advance..];
    }
    out
}

/// Extract cwd from OSC 7 escape sequence
/// Format: \x1b]7;file://hostname/path\x07  or  \x1b]7;file://hostname/path\x1b\\
fn extract_osc7_cwd(raw: &str) -> Option<String> {
    // Find OSC 7 sequence start
    let marker = "\x1b]7;";
    let start = raw.find(marker)?;
    let after = &raw[start + marker.len()..];

    // Find the terminator: BEL (\x07) or ST (\x1b\\)
    let end = after.find('\x07')
        .or_else(|| after.find("\x1b\\"))?;
    let uri = &after[..end];

    // Parse file:// URI — format: file://hostname/path or file:///path
    if let Some(path_start) = uri.strip_prefix("file://") {
        // Skip hostname (find the next /)
        if let Some(slash_pos) = path_start.find('/') {
            let path = &path_start[slash_pos..];
            // URL-decode percent-encoded characters (e.g., %20 for space, CJK chars)
            let decoded = percent_decode(path);
            // Validate: must look like an absolute path, no control chars or quotes
            if !decoded.is_empty()
                && decoded.starts_with('/')
                && !decoded.contains('"')
                && !decoded.contains('\n')
                && !decoded.contains('\x1b')
                && decoded.len() < 500
            {
                return Some(decoded);
            }
        }
    }
    None
}

/// Simple percent-decoding for file URIs
fn percent_decode(s: &str) -> String {
    let mut result = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                &s[i + 1..i + 3], 16
            ) {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| s.to_string())
}

fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn strip_ansi(s: &str) -> String {
    strip_ansi_escapes::strip_str(s)
}

fn is_ai_waiting_prompt(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    // Only match Claude Code's specific prompt characters (❯ and variants)
    // Do NOT include "$", ">", ">>", ">>>" — these are regular shell prompts
    matches!(trimmed, "❯" | "❯❯" | "›")
        || trimmed.ends_with("\n❯")
        || trimmed.ends_with("\n❯❯")
        || trimmed.ends_with("\n›")
}

fn match_prompt(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Debug: log all lines being checked
    eprintln!("match_prompt checking: '{}'", trimmed);

    // Skip noise lines
    if trimmed.contains("Copyright") || trimmed.contains("版本") || trimmed.starts_with('(') || trimmed.starts_with('[') {
        return None;
    }

    // Extract content after Claude prompt "❯ " or regular prompt
    let content = if trimmed.starts_with('❯') {
        // Claude Code prompt: "❯ command args"
        // Use char slicing to avoid UTF-8 boundary issues
        trimmed.chars().skip(1).collect::<String>()
    } else {
        trimmed.to_string()
    };

    if content.is_empty() {
        return None;
    }

    let first_char = content.chars().next()?;
    if !first_char.is_alphabetic() {
        // For Windows-style prompts like "C:\path>" or "PS C:\path>", extract the path
        eprintln!("Trying extract_windows_cwd for: '{}'", trimmed);
        if let Some(cwd) = extract_windows_cwd(trimmed) {
            eprintln!("Extracted cwd from prompt: '{}'", cwd);
            return Some(format!("cd {}", cwd));
        }
        return None;
    }

    // Common command patterns (case-insensitive check via is_ai_command later)
    if content.starts_with("opencode") || content.starts_with("codex") || content.starts_with("claude") ||
       content.starts_with("git") || content.starts_with("cd") || content.starts_with("ls") ||
       content.starts_with("npm") || content.starts_with("npx") || content.starts_with("yarn") ||
       content.starts_with("Opencode") || content.starts_with("Codex") || content.starts_with("Claude") ||
       content.starts_with("Git") || content.starts_with("Cd") || content.starts_with("Ls") ||
       content.starts_with("Npm") || content.starts_with("Npx") || content.starts_with("Yarn") {
        eprintln!("Command detected: '{}'", content);
        return Some(content.to_string());
    }

    None
}

fn is_windows_path(path: &str) -> bool {
    // Check if it's a Windows path: starts with drive letter (C:) or UNC path (\\)
    // Case insensitive check for drive letters
    if path.len() >= 2 {
        let first = path.chars().next().map(|c| c.to_ascii_lowercase()).unwrap_or(' ');
        let second = path.chars().nth(1).unwrap_or(' ');
        if first.is_ascii_alphabetic() && second == ':' {
            return true;
        }
    }
    if path.starts_with("\\\\") || path.starts_with("//") {
        return true;
    }
    false
}

fn is_drive_letter(cmd: &str) -> bool {
    // Check if it's a single drive letter like "G:" or "d:"
    if cmd.len() != 2 {
        return false;
    }
    let chars: Vec<char> = cmd.chars().collect();
    chars[0].is_ascii_alphabetic() && chars[1] == ':'
}

/// Extract current working directory from Windows-style prompt
fn extract_windows_cwd(prompt: &str) -> Option<String> {
    // Match patterns like "C:\path>" or "G:\folder\file>" or "PS C:\path>"

    // Handle PowerShell prompt "PS C:\path>"
    if prompt.starts_with("PS ") {
        let path_part = &prompt[3..]; // Skip "PS "
        if let Some(idx) = path_part.rfind('>') {
            let before_gt = path_part[..idx].trim();
            if before_gt.len() >= 2 && before_gt.chars().nth(1) == Some(':') {
                eprintln!("Extracted PS cwd: '{}'", before_gt);
                return Some(before_gt.to_string());
            }
        }
        return None;
    }

    // Skip if starts with special characters that aren't drives
    if prompt.starts_with('>') {
        return None;
    }

    // Match patterns like "C:\path" or "G:\folder\file"
    if let Some(idx) = prompt.rfind('>') {
        let before_gt = prompt[..idx].trim();
        // Check if it looks like a Windows path (has : or starts with \)
        if before_gt.len() >= 2 {
            let second_char = before_gt.chars().nth(1);
            if second_char == Some(':') || before_gt.starts_with('\\') {
                // This is a Windows path like C:\path
                let path = before_gt.to_string();
                eprintln!("Extracted Windows cwd: '{}'", path);
                return Some(path);
            }
        }
    }

    None
}

fn is_ai_command(cmd: &str) -> Option<&'static str> {
    let lower = cmd.to_lowercase();
    eprintln!("Checking AI command: '{}'", lower);

    // Direct command match (e.g., "opencode", "opencode .", "opencode -r")
    if lower == "claude" || lower.starts_with("claude ") {
        eprintln!("Detected: claude");
        return Some("claude");
    }
    if lower == "opencode" || lower.starts_with("opencode ") {
        eprintln!("Detected: opencode");
        return Some("opencode");
    }
    if lower == "codex" || lower.starts_with("codex ") {
        eprintln!("Detected: codex");
        return Some("codex");
    }
    if lower == "aider" || lower.starts_with("aider ") {
        eprintln!("Detected: aider");
        return Some("aider");
    }

    // npx/yarn/pnpm patterns (e.g., "npx opencode", "pnpm exec opencode")
    if lower.contains("opencode")
        && (lower.starts_with("npx")
            || lower.starts_with("yarn")
            || lower.starts_with("pnpm")
            || lower.starts_with("npm"))
    {
        eprintln!("Detected: opencode (via package manager)");
        return Some("opencode");
    }
    if lower.contains("codex")
        && (lower.starts_with("npx")
            || lower.starts_with("yarn")
            || lower.starts_with("pnpm")
            || lower.starts_with("npm"))
    {
        eprintln!("Detected: codex (via package manager)");
        return Some("codex");
    }
    if lower.contains("claude")
        && (lower.starts_with("npx")
            || lower.starts_with("yarn")
            || lower.starts_with("pnpm")
            || lower.starts_with("npm"))
    {
        eprintln!("Detected: claude (via package manager)");
        return Some("claude");
    }

    None
}

fn is_tool_call(line: &str) -> bool {
    const TOOLS: &[&str] = &[
        "Read",
        "Edit",
        "Write",
        "Bash",
        "Grep",
        "Glob",
        "Agent",
        "WebSearch",
        "WebFetch",
        "NotebookEdit",
        "TodoWrite",
        "Skill",
        "ToolSearch",
    ];
    TOOLS.iter().any(|t| line.starts_with(t))
}

fn generate_tab_name(entries: &[SidebarEntry]) -> Option<String> {
    for entry in entries.iter().filter(|e| e.entry_type == "user-input") {
        let text = entry.content.trim();
        if text.len() <= 3 {
            continue;
        }
        if matches!(
            text.to_lowercase().as_str(),
            "y" | "n" | "yes" | "no" | "claude" | "exit" | "quit" | "cd" | "ls"
        ) {
            continue;
        }
        if text.len() <= 20 {
            return Some(text.to_string());
        }
        let cut = truncate_str(text, 20);
        let last_space = cut.rfind(' ');
        return Some(if let Some(i) = last_space {
            if i > 10 {
                format!("{}…", truncate_str(cut, i))
            } else {
                format!("{}…", cut)
            }
        } else {
            format!("{}…", cut)
        });
    }
    None
}

/// Extract new cwd from cd command
fn extract_cd_path(cmd: &str, current_cwd: &str) -> Option<String> {
    let lower = cmd.to_lowercase();
    if !lower.starts_with("cd ") && lower != "cd" {
        return None;
    }

    // Extract path argument
    let args = cmd[3..].trim();
    if args.is_empty() {
        // cd without args goes home
        return dirs_next_home();
    }

    // Handle cd - (go to previous directory) - just return current for now
    if args == "-" {
        return Some(current_cwd.to_string());
    }

    // Remove quotes if present
    let path = args.trim_matches('"').trim_matches('\'');

    // Absolute path
    if is_absolute_path(path) {
        return Some(normalize_path(path));
    }

    // Relative path
    if current_cwd.is_empty() {
        if let Some(home) = dirs_next_home() {
            return Some(normalize_path(&join_path(&home, path)));
        }
        return None;
    }

    Some(normalize_path(&join_path(current_cwd, path)))
}

fn is_absolute_path(path: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        path.len() >= 2 && path.chars().nth(1) == Some(':') || path.starts_with("\\\\")
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.starts_with('/')
    }
}

fn join_path(base: &str, path: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("{}\\{}", base, path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("{}/{}", base, path)
    }
}

fn normalize_path(path: &str) -> String {
    // Simple normalization: resolve . and ..
    #[cfg(target_os = "windows")]
    let parts: Vec<&str> = path.split('\\').collect();
    #[cfg(not(target_os = "windows"))]
    let parts: Vec<&str> = path.split('/').collect();

    let mut result = Vec::new();
    for part in parts {
        match part {
            "" | "." => continue,
            ".." => { result.pop(); }
            _ => result.push(part),
        }
    }

    #[cfg(target_os = "windows")]
    return result.join("\\");
    #[cfg(not(target_os = "windows"))]
    return result.join("/");
}

fn dirs_next_home() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok()
    }
}
