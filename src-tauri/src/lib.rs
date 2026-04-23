mod commands;
mod notification;
mod output_parser;
mod pty_manager;

use output_parser::OutputParser;
use pty_manager::PtyManager;
use std::sync::{Arc, Mutex, RwLock};
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// Window visibility state for Alt+S toggle
struct WindowState {
    visible: bool,
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
        .setup(|app| {
            app.manage(Arc::new(RwLock::new(PtyManager::new())));
            app.manage(Arc::new(Mutex::new(OutputParser::new())));
            app.manage(Arc::new(Mutex::new(WindowState { visible: true })));

            let alt_s = Shortcut::new(Some(Modifiers::ALT), Code::KeyS);
            app.global_shortcut().on_shortcut(alt_s, |app, _shortcut, event| {
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
            })?;

            // Quick Terminal: Cmd+` on macOS, Ctrl+` elsewhere. Toggle visibility + focus.
            #[cfg(target_os = "macos")]
            let quick_mod = Modifiers::SUPER;
            #[cfg(not(target_os = "macos"))]
            let quick_mod = Modifiers::CONTROL;
            let quick_shortcut = Shortcut::new(Some(quick_mod), Code::Backquote);
            app.global_shortcut().on_shortcut(quick_shortcut, |app, _s, event| {
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
            })?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_terminal,
            commands::switch_shell,
            commands::write_terminal,
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
            commands::convert_image_path,
            commands::notify_task_done,
            commands::clear_badge,
            commands::list_claude_sessions,
            commands::get_claude_session_history,
            commands::delete_claude_session,
            commands::delete_history_entry,
            commands::clear_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Terminal");
}
