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
    user_input_count: u32,
    auto_renamed: bool,
    claude_detected: bool,
}

impl TabState {
    fn new() -> Self {
        Self {
            entries: Vec::new(),
            buffer: String::new(),
            mute_until: 0,
            is_active: false,
            user_input_count: 0,
            auto_renamed: false,
            claude_detected: false,
        }
    }
}

pub struct OutputParser {
    states: HashMap<String, TabState>,
}

impl OutputParser {
    pub fn new() -> Self {
        Self { states: HashMap::new() }
    }

    pub fn init_tab(&mut self, tab_id: &str) {
        self.states.entry(tab_id.to_string()).or_insert_with(TabState::new);
    }

    pub fn remove_tab(&mut self, tab_id: &str) {
        self.states.remove(tab_id);
    }

    pub fn get_entries(&self, tab_id: &str) -> Vec<SidebarEntry> {
        self.states.get(tab_id).map(|s| s.entries.clone()).unwrap_or_default()
    }

    pub fn process(
        &mut self,
        tab_id: &str,
        raw: &str,
        on_status: impl Fn(String, TabStatus),
        on_entry: impl Fn(String, SidebarEntry),
        on_rename: impl Fn(String, String),
        on_claude_detected: impl Fn(String, String),
    ) {
        let state = self.states.entry(tab_id.to_string()).or_insert_with(TabState::new);
        let now = now_ms();

        // Bell char → done-unseen
        if raw.contains('\x07') && !state.is_active {
            on_status(tab_id.to_string(), TabStatus::DoneUnseen);
        }

        // Skip parsing during resize quiet period
        if now < state.mute_until { return; }

        let cleaned = strip_ansi(raw);
        state.buffer.push_str(&cleaned);

        let mut lines: Vec<String> = state.buffer.split('\n').map(|s| s.to_string()).collect();
        state.buffer = lines.pop().unwrap_or_default();

        for line in lines {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }

            // User prompt: ❯ xxx
            if let Some(content) = match_prompt(trimmed) {
                if content.is_empty() { continue; }

                // Detect AI launch
                if !state.claude_detected && is_ai_command(&content) {
                    state.claude_detected = true;
                    let cwd = String::new(); // cwd detection done separately
                    on_claude_detected(tab_id.to_string(), cwd);
                }

                // Deduplicate
                if let Some(last) = state.entries.last() {
                    if last.entry_type == "user-input" && last.content == content { continue; }
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
                if !state.claude_detected && state.user_input_count == 3 {
                    state.claude_detected = true;
                    on_claude_detected(tab_id.to_string(), String::new());
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
                    if last.entry_type == "tool-call" && last.content == content { continue; }
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
    }

    pub fn mute_tab(&mut self, tab_id: &str, ms: u64) {
        let state = self.states.entry(tab_id.to_string()).or_insert_with(TabState::new);
        state.mute_until = now_ms() + ms;
        state.buffer.clear();
    }
}

fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes { return s; }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    &s[..end]
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn strip_ansi(s: &str) -> String {
    strip_ansi_escapes::strip_str(s)
}

fn match_prompt(line: &str) -> Option<String> {
    line.strip_prefix('❯').map(|s| s.trim().to_string())
}

fn is_ai_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    lower.starts_with("claude") || lower.starts_with("aider") || lower.starts_with("cursor")
}

fn is_tool_call(line: &str) -> bool {
    const TOOLS: &[&str] = &[
        "Read", "Edit", "Write", "Bash", "Grep", "Glob", "Agent",
        "WebSearch", "WebFetch", "NotebookEdit", "TodoWrite", "Skill", "ToolSearch",
    ];
    TOOLS.iter().any(|t| line.starts_with(t))
}

fn generate_tab_name(entries: &[SidebarEntry]) -> Option<String> {
    for entry in entries.iter().filter(|e| e.entry_type == "user-input") {
        let text = entry.content.trim();
        if text.len() <= 3 { continue; }
        if matches!(text.to_lowercase().as_str(), "y" | "n" | "yes" | "no" | "claude" | "exit" | "quit" | "cd" | "ls") { continue; }
        if text.len() <= 20 { return Some(text.to_string()); }
        let cut = truncate_str(text, 20);
        let last_space = cut.rfind(' ');
        return Some(if let Some(i) = last_space { if i > 10 { format!("{}…", truncate_str(cut, i)) } else { format!("{}…", cut) } } else { format!("{}…", cut) });
    }
    None
}
