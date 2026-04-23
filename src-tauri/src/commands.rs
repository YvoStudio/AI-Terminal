use crate::output_parser::{OutputParser, SidebarEntry};
use crate::pty_manager::PtyManager;
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedNoteBlock {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedTab {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default, rename = "noteBlocks", alias = "note_blocks")]
    pub note_blocks: Vec<SavedNoteBlock>,
    #[serde(default = "default_shell_str")]
    pub shell: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default, rename = "aiTool", alias = "ai_tool")]
    pub ai_tool: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub name: String,
    pub cwd: String,
    pub timestamp: u64,
    #[serde(default = "default_shell_str")]
    pub shell: String,
    #[serde(default)]
    pub ai_tool: Option<String>,
}

fn default_shell_str() -> String { "cmd".to_string() }

/// Truncate a string at a char boundary, never panicking on multi-byte chars.
fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes { return s; }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    &s[..end]
}

fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn tabs_file(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("saved-tabs.json")
}

fn history_file(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("tab-history.json")
}

// ── Terminal commands ──────────────────────────────────────────────────────

fn make_pty_callback(
    app: AppHandle,
    tab_id: String,
    parser_arc: Arc<Mutex<OutputParser>>,
    pty_state: Arc<RwLock<PtyManager>>,
) -> impl Fn(String) + Send + 'static {
    move |data: String| {
        let _ = app.emit(&format!("terminal-output-{}", tab_id), data.clone());
        // OSC 9 / 777 (notifications) + OSC 9;4 (progress): emit events for frontend to surface.
        let (notifications, progress) = crate::output_parser::extract_notifications_and_progress(&data);
        if !notifications.is_empty() || !progress.is_empty() {
            eprintln!(">>> OSC 9/777: {} notifications, {} progress updates", notifications.len(), progress.len());
        }
        for (title, body) in notifications {
            eprintln!(">>> sending notification title='{}' body='{}'", title, body);
            use tauri_plugin_notification::NotificationExt;
            if let Err(e) = app.notification().builder().title(&title).body(&body).show() {
                eprintln!(">>> notification error: {}", e);
            }
            let _ = app.emit("terminal-notification", serde_json::json!({
                "tabId": tab_id, "title": title, "body": body
            }));
        }
        for (state, pct) in progress {
            let _ = app.emit("terminal-progress", serde_json::json!({
                "tabId": tab_id, "state": state, "progress": pct
            }));
        }
        if let Ok(mut parser) = parser_arc.lock() {
            let app_ref = &app;
            parser.process(
                &tab_id,
                &data,
                |tid, status| {
                    let _ = app_ref.emit("tab-status-changed", serde_json::json!({ "tabId": tid, "status": status }));
                },
                |tid, entry| {
                    let _ = app.emit("sidebar-entry-added", serde_json::json!({ "tabId": tid, "entry": entry }));
                },
                |tid, name| {
                    let _ = app.emit("tab-auto-rename", serde_json::json!({ "tabId": tid, "name": name }));
                },
                |tid, cwd, ai_tool| {
                    let _ = app.emit("tab-ai-detected", serde_json::json!({ "tabId": tid, "cwd": cwd, "aiTool": ai_tool }));
                },
                |tid, cwd| {
                    eprintln!(">>> Backend: CWD changed for tab {} to {}", tid, cwd);
                    // Update PtyManager's cwd so get_terminal_cwd returns the latest value
                    let mgr = pty_state.read().unwrap();
                    mgr.update_cwd(&tid, cwd.clone());
                    let _ = app.emit("tab-cwd-changed", serde_json::json!({ "tabId": tid, "cwd": cwd }));
                },
            );
        }
    }
}

#[tauri::command]
pub fn create_terminal(
    app: AppHandle,
    pty_state: State<'_, Arc<RwLock<PtyManager>>>,
    parser_state: State<'_, Arc<Mutex<OutputParser>>>,
    cwd: Option<String>,
    preferred_id: Option<String>,
) -> Result<String, String> {
    // Reuse the previous-session id when restoring a saved tab so that
    // scrollback files keyed on tab id can be matched back up.
    let tab_id = preferred_id
        .filter(|s| !s.is_empty() && s.len() <= 64
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let initial_cwd = cwd.clone().unwrap_or_else(|| {
        std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default()
    });

    {
        let mut parser = parser_state.lock().map_err(|e| e.to_string())?;
        parser.init_tab_with_cwd(&tab_id, &initial_cwd);
    }

    let parser_arc = Arc::clone(&*parser_state);
    let pty_arc = Arc::clone(&*pty_state);
    let cb = make_pty_callback(app, tab_id.clone(), parser_arc, pty_arc);
    let mut mgr = pty_state.write().map_err(|e| e.to_string())?;
    mgr.create(tab_id.clone(), cwd, cb)?;

    Ok(tab_id)
}

#[tauri::command]
pub fn switch_shell(
    app: AppHandle,
    pty_state: State<'_, Arc<RwLock<PtyManager>>>,
    parser_state: State<'_, Arc<Mutex<OutputParser>>>,
    tab_id: String,
    shell: String,
) -> Result<(), String> {
    let shell_exe = match shell.as_str() {
        "cmd"        => "cmd.exe".to_string(),
        "powershell" => "powershell.exe".to_string(),
        "wsl"        => "wsl.exe".to_string(),
        other        => return Err(format!("Unknown shell: {}", other)),
    };

    // Capture cwd before closing
    let cwd = {
        let mgr = pty_state.read().map_err(|e| e.to_string())?;
        let cwd_str = mgr.get_cwd(&tab_id);
        if cwd_str.is_empty() { None } else { Some(cwd_str) }
    };

    // Close old PTY
    {
        let mut mgr = pty_state.write().map_err(|e| e.to_string())?;
        mgr.close(&tab_id);
    }

    // Re-init parser state for the tab, preserving cwd
    {
        let mut parser = parser_state.lock().map_err(|e| e.to_string())?;
        let cwd_str = cwd.clone().unwrap_or_default();
        parser.init_tab_with_cwd(&tab_id, &cwd_str);
    }

    // Create new PTY with same cwd
    let parser_arc = Arc::clone(&*parser_state);
    let pty_arc = Arc::clone(&*pty_state);
    let cb = make_pty_callback(app, tab_id.clone(), parser_arc, pty_arc);
    let mut mgr = pty_state.write().map_err(|e| e.to_string())?;
    mgr.create_with_shell(tab_id.clone(), cwd, shell_exe, cb)?;

    Ok(())
}

#[tauri::command]
pub fn write_terminal(
    state: State<'_, Arc<RwLock<PtyManager>>>,
    tab_id: String,
    data: String,
) -> Result<(), String> {
    let mgr = state.read().map_err(|e| e.to_string())?;
    mgr.write(&tab_id, &data)
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, Arc<RwLock<PtyManager>>>,
    tab_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mgr = state.read().map_err(|e| e.to_string())?;
    mgr.resize(&tab_id, cols, rows)
}

#[tauri::command]
pub fn close_terminal(
    pty_state: State<'_, Arc<RwLock<PtyManager>>>,
    parser_state: State<'_, Arc<Mutex<OutputParser>>>,
    tab_id: String,
) -> Result<(), String> {
    let mut mgr = pty_state.write().map_err(|e| e.to_string())?;
    mgr.close(&tab_id);
    let mut parser = parser_state.lock().map_err(|e| e.to_string())?;
    parser.remove_tab(&tab_id);
    Ok(())
}

#[tauri::command]
pub fn get_terminal_cwd(
    state: State<'_, Arc<RwLock<PtyManager>>>,
    tab_id: String,
) -> Result<String, String> {
    let mgr = state.read().map_err(|e| e.to_string())?;
    Ok(mgr.get_cwd(&tab_id))
}

#[tauri::command]
pub fn get_sidebar_entries(
    state: State<'_, Arc<Mutex<OutputParser>>>,
    tab_id: String,
) -> Result<Vec<SidebarEntry>, String> {
    let parser = state.lock().map_err(|e| e.to_string())?;
    Ok(parser.get_entries(&tab_id))
}

// ── Notification ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn clear_badge(app: AppHandle) -> Result<(), String> {
    crate::notification::clear_badge(&app);
    Ok(())
}

#[tauri::command]
pub fn notify_task_done(
    app: AppHandle,
    pending_count: u32,
    request_attention: bool,
) -> Result<(), String> {
    crate::notification::sync_pending_tasks(&app, pending_count, request_attention);
    Ok(())
}

// ── Tabs persistence ───────────────────────────────────────────────────────

#[tauri::command]
pub fn save_tabs(app: AppHandle, tabs: Vec<SavedTab>) -> Result<(), String> {
    let path = tabs_file(&app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let json = serde_json::to_string(&tabs).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fire_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(&title).body(&body).show().map_err(|e| e.to_string())
}

fn scrollback_path(app: &AppHandle, tab_id: &str) -> Option<PathBuf> {
    // Sanitize: only allow alphanumerics and dashes in tab_id
    if tab_id.is_empty() || tab_id.len() > 64
        || !tab_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    Some(app_data_dir(app).join("scrollback").join(format!("{}.txt", tab_id)))
}

#[tauri::command]
pub fn save_scrollback(app: AppHandle, tab_id: String, data: String) -> Result<(), String> {
    let path = scrollback_path(&app, &tab_id).ok_or("invalid tab_id")?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).ok(); }
    // Cap at 2 MB to bound disk growth
    let max = 2 * 1024 * 1024;
    let trimmed = if data.len() > max { &data[data.len() - max..] } else { &data[..] };
    fs::write(&path, trimmed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_scrollback(app: AppHandle, tab_id: String) -> Result<String, String> {
    let path = match scrollback_path(&app, &tab_id) { Some(p) => p, None => return Ok(String::new()) };
    if !path.exists() { return Ok(String::new()); }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_scrollback(app: AppHandle, tab_id: String) -> Result<(), String> {
    if let Some(path) = scrollback_path(&app, &tab_id) {
        let _ = fs::remove_file(&path);
    }
    Ok(())
}

#[tauri::command]
pub fn load_tabs(app: AppHandle) -> Result<Vec<SavedTab>, String> {
    let path = tabs_file(&app);
    if !path.exists() { return Ok(vec![]); }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

// ── History ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn load_history(app: AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let path = history_file(&app);
    if !path.exists() { return Ok(vec![]); }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_history(app: AppHandle, tab_id: String, name: String, cwd: String, shell: Option<String>, ai_tool: Option<String>) -> Result<(), String> {
    let _ = tab_id;

    // Skip saving if cwd is the user's home directory (or empty)
    if cwd.is_empty() {
        return Ok(());
    }
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        if std::path::Path::new(&cwd) == std::path::Path::new(&home) {
            return Ok(());
        }
    }
    let path = history_file(&app);
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).ok(); }

    let mut history: Vec<HistoryEntry> = if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else { vec![] };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    // Remove existing entry with same cwd AND same ai_tool (keep only latest per cwd+tool combo)
    history.retain(|e| !(e.cwd == cwd && e.ai_tool == ai_tool));

    // Use first user message or tab name for display
    let display_name = if name.is_empty() {
        cwd.split('\\').last().unwrap_or(&cwd).to_string()
    } else {
        name
    };

    history.insert(0, HistoryEntry { name: display_name, cwd, timestamp: ts, shell: shell.unwrap_or_else(default_shell_str), ai_tool });
    history.truncate(20);

    let json = serde_json::to_string(&history).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_history_name(
    app: AppHandle,
    tab_id: String,
    new_name: String,
    cwd: Option<String>,
    ai_tool: Option<String>,
) -> Result<(), String> {
    let _ = tab_id;
    let path = history_file(&app);
    if !path.exists() { return Ok(()); }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut history: Vec<HistoryEntry> = serde_json::from_str(&data).unwrap_or_default();

    let target_cwd = cwd.unwrap_or_default();
    if let Some(entry) = history.iter_mut().find(|entry| {
        !target_cwd.is_empty() && entry.cwd == target_cwd && entry.ai_tool == ai_tool
    }) {
        entry.name = new_name;
    } else if let Some(entry) = history.first_mut() {
        entry.name = new_name;
    }
    let json = serde_json::to_string(&history).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

// ── File dialogs ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn select_file(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog()
        .file()
        .blocking_pick_file();
    Ok(path.map(|p| p.to_string()).unwrap_or_default())
}

#[tauri::command]
pub async fn select_image(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"])
        .blocking_pick_file();
    Ok(path.map(|p| p.to_string()).unwrap_or_default())
}

#[tauri::command]
pub async fn select_directory(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog()
        .file()
        .blocking_pick_folder();
    Ok(path.map(|p| p.to_string()).unwrap_or_default())
}

#[tauri::command]
pub async fn select_path(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    // Use pick_folder first won't work — use std approach to show open panel with both
    // On macOS, blocking_pick_file allows file selection; for dirs use separate command
    // Simplest: try file first, if cancelled return empty
    let path = app.dialog()
        .file()
        .set_title("选择文件或目录")
        .blocking_pick_file();
    Ok(path.map(|p| p.to_string()).unwrap_or_default())
}

// ── Claude session scanning ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSession {
    pub session_id: String,
    pub slug: String,
    pub cwd: String,
    pub timestamp: String,
    pub user_messages: Vec<String>,
}

#[tauri::command]
pub fn list_claude_sessions(project_cwd: Option<String>) -> Result<Vec<ClaudeSession>, String> {
    let home = dirs_home().ok_or("Cannot determine home directory")?;
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() { return Ok(vec![]); }

    let mut sessions: Vec<ClaudeSession> = Vec::new();

    // If project_cwd is given, scan only that project dir; otherwise scan all
    let project_dirs: Vec<PathBuf> = if let Some(cwd) = &project_cwd {
        let encoded = cwd.replace('/', "-");
        let dir = projects_dir.join(&encoded);
        if dir.exists() { vec![dir] } else { vec![] }
    } else {
        fs::read_dir(&projects_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_dir())
            .collect()
    };

    for proj_dir in project_dirs {
        let jsonl_files: Vec<PathBuf> = fs::read_dir(&proj_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|e| e == "jsonl").unwrap_or(false))
            .collect();

        for jsonl_path in jsonl_files {
            if let Ok(session) = parse_claude_session(&jsonl_path) {
                sessions.push(session);
            }
        }
    }

    // Sort by timestamp descending (newest first)
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    sessions.truncate(30);
    Ok(sessions)
}

#[tauri::command]
pub fn get_claude_session_history(session_id: String) -> Result<Vec<String>, String> {
    let home = dirs_home().ok_or("Cannot determine home directory")?;
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() { return Ok(vec![]); }

    // Search all project dirs for the session
    for entry in fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() { continue; }
        let jsonl = path.join(format!("{}.jsonl", session_id));
        if jsonl.exists() {
            return parse_session_user_messages(&jsonl, 50);
        }
    }
    Ok(vec![])
}

#[tauri::command]
pub fn delete_claude_session(session_id: String) -> Result<(), String> {
    let home = dirs_home().ok_or("Cannot determine home directory")?;
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() { return Ok(()); }
    for entry in fs::read_dir(&projects_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() { continue; }
        let jsonl = path.join(format!("{}.jsonl", session_id));
        if jsonl.exists() {
            fs::remove_file(&jsonl).map_err(|e| e.to_string())?;
            // Also remove subagent dir if exists
            let sub_dir = path.join(&session_id);
            if sub_dir.exists() { let _ = fs::remove_dir_all(&sub_dir); }
            return Ok(());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn clear_history(app: AppHandle) -> Result<(), String> {
    let path = history_file(&app);
    if path.exists() {
        fs::write(&path, "[]").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_history_entry(app: AppHandle, index: usize) -> Result<(), String> {
    let path = history_file(&app);
    if !path.exists() { return Ok(()); }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut history: Vec<HistoryEntry> = serde_json::from_str(&data).unwrap_or_default();
    if index < history.len() {
        history.remove(index);
        let json = serde_json::to_string(&history).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn dirs_home() -> Option<PathBuf> {
    // Windows: use USERPROFILE, Unix: use HOME
    if cfg!(windows) {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    } else {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

fn parse_claude_session(path: &PathBuf) -> Result<ClaudeSession, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut session_id = String::new();
    let mut slug = String::new();
    let mut cwd = String::new();
    let mut last_timestamp = String::new();
    let mut user_messages: Vec<String> = Vec::new();

    for line in content.lines() {
        if line.is_empty() { continue; }
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Extract sessionId from any message
        if session_id.is_empty() {
            if let Some(sid) = val.get("sessionId").and_then(|v| v.as_str()) {
                session_id = sid.to_string();
            }
        }

        // Extract slug from progress messages
        if slug.is_empty() {
            if let Some(s) = val.get("slug").and_then(|v| v.as_str()) {
                slug = s.to_string();
            }
        }

        // Extract cwd
        if let Some(c) = val.get("cwd").and_then(|v| v.as_str()) {
            if cwd.is_empty() { cwd = c.to_string(); }
        }

        // Track latest timestamp
        if let Some(ts) = val.get("timestamp").and_then(|v| v.as_str()) {
            last_timestamp = ts.to_string();
        }

        // Collect user messages
        if val.get("type").and_then(|v| v.as_str()) == Some("user") {
            if let Some(content) = val.get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
            {
                let trimmed = content.trim();
                if !trimmed.is_empty() && !trimmed.starts_with("<command") && trimmed.len() <= 200 {
                    user_messages.push(truncate_str(trimmed, 100).to_string());
                }
            }
        }
    }

    if session_id.is_empty() {
        // Try filename as session ID
        session_id = path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
    }

    if slug.is_empty() {
        slug = session_id.chars().take(8).collect();
    }

    // Keep last 5 user messages as preview
    let preview_messages: Vec<String> = user_messages.into_iter().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect();

    Ok(ClaudeSession {
        session_id,
        slug,
        cwd,
        timestamp: last_timestamp,
        user_messages: preview_messages,
    })
}

fn parse_session_user_messages(path: &PathBuf, limit: usize) -> Result<Vec<String>, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut messages: Vec<String> = Vec::new();

    for line in content.lines() {
        if line.is_empty() { continue; }
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if val.get("type").and_then(|v| v.as_str()) == Some("user") {
            if let Some(content) = val.get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
            {
                let trimmed = content.trim();
                if !trimmed.is_empty() && !trimmed.starts_with("<command") {
                    messages.push(truncate_str(trimmed, 200).to_string());
                }
            }
        }
    }

    // Return last N messages
    let start = if messages.len() > limit { messages.len() - limit } else { 0 };
    Ok(messages[start..].to_vec())
}

// ── Clipboard ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.get_text().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_clipboard_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())
}

/// Read clipboard image (if any) via arboard, save to temp file, return path.
/// Returns empty string if clipboard has no image.
#[tauri::command]
pub fn read_clipboard_image() -> Result<String, String> {
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(cb) => cb,
        Err(e) => {
            eprintln!("[Clipboard] Failed to open clipboard: {}", e);
            return Ok(String::new());
        }
    };

    let img = match clipboard.get_image() {
        Ok(img) => img,
        Err(e) => {
            // Not an image or format not supported - return empty to allow text fallback
            eprintln!("[Clipboard] No image or unsupported format: {}", e);
            return Ok(String::new());
        }
    };

    eprintln!("[Clipboard] Got image: {}x{}, {} bytes", img.width, img.height, img.bytes.len());

    // Encode as PNG using the png crate
    let temp_dir = std::env::temp_dir().join("ai-terminal-images");
    if let Err(e) = fs::create_dir_all(&temp_dir) {
        eprintln!("[Clipboard] Failed to create temp dir: {}", e);
        return Err(e.to_string());
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let file_path = temp_dir.join(format!("paste-{}.png", ts));

    let file = match fs::File::create(&file_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[Clipboard] Failed to create file: {}", e);
            return Err(e.to_string());
        }
    };

    let w = std::io::BufWriter::new(file);
    let mut encoder = png::Encoder::new(w, img.width as u32, img.height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);

    let mut writer = match encoder.write_header() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[Clipboard] Failed to write PNG header: {}", e);
            return Err(e.to_string());
        }
    };

    if let Err(e) = writer.write_image_data(&img.bytes) {
        eprintln!("[Clipboard] Failed to write PNG data: {}", e);
        return Err(e.to_string());
    }

    eprintln!("[Clipboard] Saved image to: {:?}", file_path);
    Ok(file_path.to_string_lossy().to_string())
}

// ── Clipboard image ────────────────────────────────────────────────────────

#[tauri::command]
pub fn save_clipboard_image(app: AppHandle, data_url: String) -> Result<String, String> {
    let prefix = "data:image/";
    if !data_url.starts_with(prefix) { return Err("Invalid data URL".into()); }
    let rest = &data_url[prefix.len()..];
    let semi = rest.find(';').ok_or("Invalid data URL")?;
    let ext = &rest[..semi];
    let base64_part = rest.find(",").map(|i| &rest[i+1..]).ok_or("Invalid data URL")?;

    let bytes = general_purpose::STANDARD.decode(base64_part).map_err(|e| e.to_string())?;

    let temp_dir = std::env::temp_dir().join("ai-terminal-images");
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("paste-{}.{}", ts, ext);
    let file_path = temp_dir.join(&filename);
    fs::write(&file_path, bytes).map_err(|e| e.to_string())?;

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn convert_image_path(file_path: String) -> Result<String, String> {
    // Read the source image file
    let bytes = fs::read(&file_path).map_err(|e| format!("Failed to read image: {}", e))?;

    // Get file extension from original path
    let ext = PathBuf::from(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    // Create temp directory for images
    let temp_dir = std::env::temp_dir().join("ai-terminal-images");
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    // Generate unique filename
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("drag-{}.{}.{}", ts, Uuid::new_v4().to_string().split('-').next().unwrap_or("x"), ext);
    let dest_path = temp_dir.join(&filename);

    // Write the file
    fs::write(&dest_path, bytes).map_err(|e| e.to_string())?;

    Ok(dest_path.to_string_lossy().to_string())
}
