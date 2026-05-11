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
            app.manage(Arc::new(RwLock::new(PtyManager::new())));
            let parser = Arc::new(Mutex::new(OutputParser::new()));
            app.manage(parser.clone());
            app.manage(Arc::new(Mutex::new(WindowState { visible: true })));

            // Idle-stream watcher: detect when AI tabs stop receiving output and emit
            // done-unseen so the tab gets a red dot. Claude Code doesn't reliably emit
            // BEL or OSC title at end-of-turn, so polling for silence is our best signal.
            let idle_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let done = {
                        let Ok(mut p) = parser.lock() else { continue };
                        // Threshold must exceed the frontend's `isLikelyStillExecuting`
                        // window (1800ms) so the debounce in main.ts releases instead of
                        // looping back to executing.
                        p.collect_idle_done(2000)
                    };
                    for tid in done {
                        let _ = idle_handle.emit("tab-status-changed", serde_json::json!({
                            "tabId": tid,
                            "status": "done-unseen"
                        }));
                    }
                }
            });

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
                .menu_on_left_click(false)
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Terminal");
}
