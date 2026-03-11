mod commands;
mod notification;
mod output_parser;
mod pty_manager;

use output_parser::OutputParser;
use pty_manager::PtyManager;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Mutex::new(PtyManager::new()));
            app.manage(Arc::new(Mutex::new(OutputParser::new())));
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
            commands::load_history,
            commands::add_history,
            commands::update_history_name,
            commands::select_file,
            commands::select_image,
            commands::select_directory,
            commands::save_clipboard_image,
            commands::clear_badge,
            commands::list_claude_sessions,
            commands::get_claude_session_history,
            commands::delete_claude_session,
            commands::delete_history_entry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Terminal");
}
