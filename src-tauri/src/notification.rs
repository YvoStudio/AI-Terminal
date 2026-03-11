use tauri::{AppHandle, Manager};

/// Request user attention (Dock bounce on macOS, taskbar flash on Windows)
/// and set badge count for pending tabs.
pub fn notify_task_done(app: &AppHandle, pending_count: u32) {
    if let Some(win) = app.get_webview_window("main") {
        // Dock bounce / taskbar flash
        let _ = win.request_user_attention(Some(tauri::UserAttentionType::Informational));

        // Badge count on Dock icon
        #[cfg(target_os = "macos")]
        if pending_count > 0 {
            let _ = win.set_badge_label(Some(pending_count.to_string()));
        }
    }
}

/// Clear badge when the user views the tab
pub fn clear_badge(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        {
            let _ = win.set_badge_label(None::<String>);
        }
        let _ = win;
    }
}
