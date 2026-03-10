use crate::output_parser::{OutputParser, SidebarEntry, TabStatus};
use crate::pty_manager::PtyManager;
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedNoteBlock {
    pub id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedTab {
    pub name: String,
    #[serde(default)]
    pub note_blocks: Vec<SavedNoteBlock>,
    #[serde(default = "default_shell_str")]
    pub shell: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub name: String,
    pub cwd: String,
    pub timestamp: u64,
    #[serde(default = "default_shell_str")]
    pub shell: String,
}

fn default_shell_str() -> String { "cmd".to_string() }

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
) -> impl Fn(String) + Send + 'static {
    move |data: String| {
        let _ = app.emit(&format!("terminal-output-{}", tab_id), data.clone());
        if let Ok(mut parser) = parser_arc.lock() {
            parser.process(
                &tab_id,
                &data,
                |tid, status| {
                    let _ = app.emit("tab-status-changed", serde_json::json!({ "tabId": tid, "status": status }));
                },
                |tid, entry| {
                    let _ = app.emit("sidebar-entry-added", serde_json::json!({ "tabId": tid, "entry": entry }));
                },
                |tid, name| {
                    let _ = app.emit("tab-auto-rename", serde_json::json!({ "tabId": tid, "name": name }));
                },
                |tid, cwd| {
                    let _ = app.emit("tab-claude-detected", serde_json::json!({ "tabId": tid, "cwd": cwd }));
                },
            );
        }
    }
}

#[tauri::command]
pub fn create_terminal(
    app: AppHandle,
    pty_state: State<'_, Mutex<PtyManager>>,
    parser_state: State<'_, Arc<Mutex<OutputParser>>>,
    cwd: Option<String>,
) -> Result<String, String> {
    let tab_id = Uuid::new_v4().to_string();

    {
        let mut parser = parser_state.lock().map_err(|e| e.to_string())?;
        parser.init_tab(&tab_id);
    }

    let parser_arc = Arc::clone(&*parser_state);
    let cb = make_pty_callback(app, tab_id.clone(), parser_arc);
    let mut mgr = pty_state.lock().map_err(|e| e.to_string())?;
    mgr.create(tab_id.clone(), cwd, cb)?;

    Ok(tab_id)
}

#[tauri::command]
pub fn switch_shell(
    app: AppHandle,
    pty_state: State<'_, Mutex<PtyManager>>,
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
        let mgr = pty_state.lock().map_err(|e| e.to_string())?;
        let cwd_str = mgr.get_cwd(&tab_id);
        if cwd_str.is_empty() { None } else { Some(cwd_str) }
    };

    // Close old PTY
    {
        let mut mgr = pty_state.lock().map_err(|e| e.to_string())?;
        mgr.close(&tab_id);
    }

    // Re-init parser state for the tab
    {
        let mut parser = parser_state.lock().map_err(|e| e.to_string())?;
        parser.init_tab(&tab_id);
    }

    let parser_arc = Arc::clone(&*parser_state);
    let cb = make_pty_callback(app, tab_id.clone(), parser_arc);
    let mut mgr = pty_state.lock().map_err(|e| e.to_string())?;
    mgr.create_with_shell(tab_id, cwd, shell_exe, cb)
}

#[tauri::command]
pub fn write_terminal(
    state: State<'_, Mutex<PtyManager>>,
    tab_id: String,
    data: String,
) -> Result<(), String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    mgr.write(&tab_id, &data)
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, Mutex<PtyManager>>,
    tab_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    mgr.resize(&tab_id, cols, rows)
}

#[tauri::command]
pub fn close_terminal(
    pty_state: State<'_, Mutex<PtyManager>>,
    parser_state: State<'_, Arc<Mutex<OutputParser>>>,
    tab_id: String,
) -> Result<(), String> {
    let mut mgr = pty_state.lock().map_err(|e| e.to_string())?;
    mgr.close(&tab_id);
    let mut parser = parser_state.lock().map_err(|e| e.to_string())?;
    parser.remove_tab(&tab_id);
    Ok(())
}

#[tauri::command]
pub fn get_terminal_cwd(
    state: State<'_, Mutex<PtyManager>>,
    tab_id: String,
) -> Result<String, String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
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
pub fn add_history(app: AppHandle, tab_id: String, name: String, cwd: String, shell: Option<String>) -> Result<(), String> {
    let _ = tab_id;
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

    history.insert(0, HistoryEntry { name, cwd, timestamp: ts, shell: shell.unwrap_or_else(default_shell_str) });
    history.truncate(15);

    let json = serde_json::to_string(&history).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_history_name(app: AppHandle, tab_id: String, new_name: String) -> Result<(), String> {
    let _ = tab_id;
    let path = history_file(&app);
    if !path.exists() { return Ok(()); }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut history: Vec<HistoryEntry> = serde_json::from_str(&data).unwrap_or_default();
    if let Some(entry) = history.first_mut() {
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
