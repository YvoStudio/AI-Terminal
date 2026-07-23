mod commands;
mod notification;
mod output_parser;
mod pty_manager;

use output_parser::OutputParser;
use pty_manager::PtyManager;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// Window visibility state for Alt+S toggle
struct WindowState {
    visible: bool,
}

/// Install the small, managed Pi extension that renders task duration inside
/// Pi's own TUI. Keeping this in Pi (rather than painting over xterm) means the
/// live timer participates in Pi's redraws and the completed duration becomes a
/// durable transcript entry without entering the LLM context.
fn install_pi_task_duration_extension() {
    const SOURCE: &str = include_str!("../resources/pi-task-duration.ts");

    let agent_dir = std::env::var_os("PI_CODING_AGENT_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|home| std::path::PathBuf::from(home).join(".pi").join("agent"))
        });
    let Some(agent_dir) = agent_dir else { return };
    let extension_dir = agent_dir.join("extensions");
    let extension_path = extension_dir.join("ai-terminal-task-duration.ts");

    let already_current = std::fs::read_to_string(&extension_path)
        .map(|current| current == SOURCE)
        .unwrap_or(false);
    if already_current { return; }

    if let Err(err) = std::fs::create_dir_all(&extension_dir)
        .and_then(|_| std::fs::write(&extension_path, SOURCE))
    {
        eprintln!("Failed to install Pi task-duration extension: {}", err);
    }
}

/// Install AI Terminal's managed Claude status line for every desktop user.
/// Existing third-party status lines are left untouched; once our command owns
/// the slot, future app versions can safely refresh the managed script.
fn install_claude_status_line() {
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|home| std::path::PathBuf::from(home).join(".claude"))
        });
    let Some(config_dir) = config_dir else { return };

    #[cfg(target_os = "windows")]
    const SCRIPT_NAME: &str = "ai-terminal-statusline.ps1";
    #[cfg(target_os = "windows")]
    const SCRIPT_SOURCE: &str = include_str!("../resources/claude-statusline.ps1");
    #[cfg(not(target_os = "windows"))]
    const SCRIPT_NAME: &str = "ai-terminal-statusline.sh";
    #[cfg(not(target_os = "windows"))]
    const SCRIPT_SOURCE: &str = include_str!("../resources/claude-statusline.sh");

    if let Err(err) = std::fs::create_dir_all(&config_dir) {
        eprintln!("Failed to create Claude config directory: {}", err);
        return;
    }
    let script_path = config_dir.join(SCRIPT_NAME);
    if let Err(err) = std::fs::write(&script_path, SCRIPT_SOURCE) {
        eprintln!("Failed to install Claude status-line script: {}", err);
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755));
    }

    #[cfg(target_os = "windows")]
    let command = format!(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
        script_path.to_string_lossy()
    );
    #[cfg(not(target_os = "windows"))]
    let command = {
        let quoted = script_path.to_string_lossy().replace('\'', "'\"'\"'");
        format!("sh '{}'", quoted)
    };

    let settings_path = config_dir.join("settings.json");
    let mut settings = if settings_path.exists() {
        match std::fs::read_to_string(&settings_path)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        {
            Some(value) => value,
            None => {
                eprintln!("Claude settings.json is invalid; status line was not configured");
                return;
            }
        }
    } else {
        serde_json::json!({})
    };
    let Some(object) = settings.as_object_mut() else {
        eprintln!("Claude settings.json is not an object; status line was not configured");
        return;
    };

    let existing_command = object
        .get("statusLine")
        .and_then(|value| value.get("command"))
        .and_then(|value| value.as_str());
    let managed = existing_command
        .map(|value| {
            value.contains("ai-terminal-statusline.sh")
                || value.contains("ai-terminal-statusline.ps1")
        })
        .unwrap_or(false);
    if existing_command.is_some() && !managed {
        eprintln!("Claude already has a custom status line; leaving it unchanged");
        return;
    }
    if settings_path.exists() && !managed {
        let backup_path = config_dir.join("settings.json.ai-terminal.bak");
        if !backup_path.exists() {
            let _ = std::fs::copy(&settings_path, backup_path);
        }
    }

    object.insert(
        "statusLine".into(),
        serde_json::json!({ "type": "command", "command": command }),
    );
    match serde_json::to_string_pretty(&settings) {
        Ok(text) => {
            if let Err(err) = std::fs::write(&settings_path, text + "\n") {
                eprintln!("Failed to configure Claude status line: {}", err);
            }
        }
        Err(err) => eprintln!("Failed to serialize Claude settings: {}", err),
    }
}

/// Configure Codex's native status line without replacing a user's existing
/// custom selection. Codex does not expose arbitrary footer renderers, but its
/// built-in items provide live model, effort, Fast, token and context data.
fn install_codex_status_line() {
    // Keep the native line useful when Codex runs outside AI Terminal. Inside
    // AI Terminal these same values are rearranged into a split footer.
    const ITEMS: &[&str] = &[
        "total-input-tokens",
        "total-output-tokens",
        "context-window-size",
        "context-used",
        "five-hour-limit",
        "weekly-limit",
        "task-progress",
        "model-with-reasoning",
        "fast-mode",
    ];
    const PREVIOUS_ITEMS: &[&str] = &[
        "model-with-reasoning",
        "fast-mode",
        "total-input-tokens",
        "total-output-tokens",
        "context-used",
    ];
    // OSC title is a machine-readable live-data channel for the frontend. The
    // app-name marker prevents ordinary shell titles from activating the footer.
    const TITLE_ITEMS: &[&str] = &[
        "app-name",
        "model-with-reasoning",
        "fast-mode",
        "total-input-tokens",
        "total-output-tokens",
        "context-used",
        "five-hour-limit",
        "weekly-limit",
        "run-state",
        "task-progress",
        "thread-id",
    ];
    const PREVIOUS_TITLE_ITEMS: &[&str] = &[
        "app-name",
        "model-with-reasoning",
        "fast-mode",
        "total-input-tokens",
        "total-output-tokens",
        "context-used",
        "five-hour-limit",
        "weekly-limit",
        "run-state",
        "task-progress",
    ];

    let codex_dir = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|home| std::path::PathBuf::from(home).join(".codex"))
        });
    let Some(codex_dir) = codex_dir else { return };
    if let Err(err) = std::fs::create_dir_all(&codex_dir) {
        eprintln!("Failed to create Codex config directory: {}", err);
        return;
    }

    let config_path = codex_dir.join("config.toml");
    let source = if config_path.exists() {
        match std::fs::read_to_string(&config_path) {
            Ok(source) => source,
            Err(err) => {
                eprintln!("Failed to read Codex config: {}", err);
                return;
            }
        }
    } else {
        String::new()
    };
    let mut document = match source.parse::<toml_edit::DocumentMut>() {
        Ok(document) => document,
        Err(err) => {
            eprintln!("Codex config.toml is invalid; status line was not configured: {}", err);
            return;
        }
    };

    if !document.as_table().contains_key("tui") {
        document["tui"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let existing_items = document["tui"]
        .get("status_line")
        .and_then(toml_edit::Item::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(toml_edit::Value::as_str)
                .collect::<Vec<_>>()
        });
    let managed = existing_items
        .as_ref()
        .map(|items| items.as_slice() == ITEMS || items.as_slice() == PREVIOUS_ITEMS)
        .unwrap_or(false);
    if existing_items.is_some() && !managed {
        eprintln!("Codex already has a custom status line; leaving it unchanged");
        return;
    }

    if config_path.exists() && !managed {
        let backup_path = codex_dir.join("config.toml.ai-terminal.bak");
        if !backup_path.exists() {
            let _ = std::fs::copy(&config_path, backup_path);
        }
    }

    let Some(tui) = document["tui"].as_table_like_mut() else {
        eprintln!("Codex [tui] config is not a table; status line was not configured");
        return;
    };
    let mut items = toml_edit::Array::new();
    for item in ITEMS {
        items.push(*item);
    }
    tui.insert("status_line", toml_edit::value(items));
    if !tui.contains_key("status_line_use_colors") {
        tui.insert("status_line_use_colors", toml_edit::value(true));
    }

    let existing_title = tui
        .get("terminal_title")
        .and_then(toml_edit::Item::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(toml_edit::Value::as_str)
                .collect::<Vec<_>>()
        });
    let managed_title = existing_title
        .as_ref()
        .map(|items| {
            items.as_slice() == TITLE_ITEMS || items.as_slice() == PREVIOUS_TITLE_ITEMS
        })
        .unwrap_or(false);
    if existing_title.is_none() || managed_title {
        let mut title_items = toml_edit::Array::new();
        for item in TITLE_ITEMS {
            title_items.push(*item);
        }
        tui.insert("terminal_title", toml_edit::value(title_items));
    }

    if let Err(err) = std::fs::write(&config_path, document.to_string()) {
        eprintln!("Failed to configure Codex status line: {}", err);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Create .lproj directories next to binary so macOS recognizes Chinese localization
    // This makes native file dialogs display in the system language
    #[cfg(target_os = "macos")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for lproj in &["zh-Hans.lproj", "zh-Hant.lproj", "en.lproj"] {
                    let _ = std::fs::create_dir_all(dir.join(lproj));
                }
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            install_pi_task_duration_extension();
            install_claude_status_line();
            install_codex_status_line();
            app.manage(Arc::new(RwLock::new(PtyManager::new())));
            let parser = Arc::new(Mutex::new(OutputParser::new()));
            app.manage(parser.clone());
            app.manage(Arc::new(Mutex::new(WindowState { visible: true })));

            // Idle-stream watcher: last-resort safety net for tabs we couldn't
            // classify via vt100 (Unknown ui_state). For tabs we *can* classify
            // (Claude/Codex/Aider/Opencode), output_parser.rs drives transitions
            // directly off the rendered footer — this loop is just a backstop
            // for non-Claude TUIs whose patterns we haven't taught yet. 30s
            // because tool calls and image generation can legitimately stream
            // nothing for >20s.
            let idle_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    // Two jobs every tick:
                    //  1. Commit debounced Working → IdleReady transitions whose
                    //     observation window elapsed without a Working frame
                    //     cancelling them. Driven from here because Claude stops
                    //     emitting chunks once truly idle.
                    //  2. Last-resort: tabs we couldn't classify but went silent
                    //     for 30s.
                    let (committed, idle_done) = {
                        let Ok(mut p) = parser.lock() else { continue };
                        let c = p.commit_pending_idle(800);
                        let d = p.collect_idle_done(30000);
                        (c, d)
                    };
                    for (tid, status, ui) in committed {
                        let _ = idle_handle.emit("tab-status-changed", serde_json::json!({
                            "tabId": tid, "status": status,
                        }));
                        let _ = idle_handle.emit("tab-ai-ui-state-changed", serde_json::json!({
                            "tabId": tid, "state": ui,
                        }));
                    }
                    for tid in idle_done {
                        let _ = idle_handle.emit("tab-status-changed", serde_json::json!({
                            "tabId": tid,
                            "status": "done-unseen"
                        }));
                    }
                }
            });

            let alt_s = Shortcut::new(Some(Modifiers::ALT), Code::KeyS);
            if let Err(err) = app.global_shortcut().on_shortcut(alt_s, |app, _shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                if let Some(win) = app.get_webview_window("main") {
                    let state = app.state::<Arc<Mutex<WindowState>>>();
                    let mut visible = state.lock().unwrap();

                    visible.visible = !visible.visible;
                    if visible.visible {
                        let _ = win.show();
                        let _ = win.set_focus();
                    } else {
                        let _ = win.hide();
                    }
                }
            }) {
                eprintln!("Failed to register Alt+S shortcut: {}", err);
            }

            // Quick Terminal: Cmd+` on macOS, Ctrl+` elsewhere. Toggle visibility + focus.
            #[cfg(target_os = "macos")]
            let quick_mod = Modifiers::SUPER;
            #[cfg(not(target_os = "macos"))]
            let quick_mod = Modifiers::CONTROL;
            let quick_shortcut = Shortcut::new(Some(quick_mod), Code::Backquote);
            if let Err(err) = app.global_shortcut().on_shortcut(quick_shortcut, |app, _s, event| {
                if event.state() != ShortcutState::Pressed { return; }
                if let Some(win) = app.get_webview_window("quick") {
                    let is_visible = win.is_visible().unwrap_or(false);
                    let is_focused = win.is_focused().unwrap_or(false);
                    if is_visible && is_focused {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }) {
                eprintln!("Failed to register quick terminal shortcut: {}", err);
            }

            // Auto-clear Dock badge when the main window regains focus —
            // the user is looking now, so the "something happened" hint has
            // served its purpose.
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                let win = main.clone();
                main.on_window_event(move |ev| {
                    match ev {
                        tauri::WindowEvent::Focused(true) => {
                            notification::clear_badge(&handle);
                        }
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            // Red X / Cmd+Q: hide to status bar instead of quitting.
                            // App keeps running; click the tray icon to bring it back.
                            // (Cmd+W still closes the active tab via the frontend's own
                            // keyboard handler, not via this window event.)
                            api.prevent_close();
                            let _ = win.hide();
                        }
                        _ => {}
                    }
                });
            }

            // Status-bar (menu-bar) tray icon. Click to toggle window visibility.
            // Icon is marked as a template so macOS auto-tints for light/dark modes.
            let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
            let quit_item = MenuItemBuilder::with_id("tray-quit", "退出 AI Terminal").build(app)?;
            let tray_menu = MenuBuilder::new(app).item(&quit_item).build()?;
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .icon_as_template(false)
                .tooltip("AI Terminal")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id() == "tray-quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let visible = win.is_visible().unwrap_or(false);
                            let focused = win.is_focused().unwrap_or(false);
                            if visible && focused {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_terminal,
            commands::switch_shell,
            commands::write_terminal,
            commands::mark_terminal_input,
            commands::resize_terminal,
            commands::close_terminal,
            commands::get_terminal_cwd,
            commands::get_sidebar_entries,
            commands::save_tabs,
            commands::load_tabs,
            commands::fire_notification,
            commands::save_scrollback,
            commands::load_scrollback,
            commands::delete_scrollback,
            commands::load_history,
            commands::add_history,
            commands::update_history_name,
            commands::select_file,
            commands::select_image,
            commands::select_directory,
            commands::read_clipboard_text,
            commands::write_clipboard_text,
            commands::read_clipboard_image,
            commands::save_clipboard_image,
            commands::save_terminal_paste_image,
            commands::cleanup_tab_images,
            commands::list_skills,
            commands::write_clipboard_image,
            commands::write_clipboard_image_from_path,
            commands::convert_image_path,
            commands::notify_task_done,
            commands::clear_badge,
            commands::list_claude_sessions,
            commands::get_claude_session_history,
            commands::delete_claude_session,
            commands::delete_history_entry,
            commands::clear_history,
            commands::force_close_window,
            commands::load_quick_commands,
            commands::save_quick_commands,
            commands::get_git_branch,
            commands::get_codex_session_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Terminal");
}
