use tauri::{AppHandle, Manager};

/// Request user attention (Dock bounce on macOS, taskbar flash on Windows)
/// and set badge count for pending tabs.
///
/// Ghostty-style focus gate: while any app window is focused the user is
/// already watching, so Dock bounce + badge are just noise. Skip both and
/// clear any stale badge. The in-app tab-bar dot remains the sole signal.
pub fn sync_pending_tasks(app: &AppHandle, pending_count: u32, request_attention: bool) {
    let focused = app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false));
    if let Some(win) = app.get_webview_window("main") {
        if request_attention && !focused {
            let _ = win.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }

        #[cfg(not(target_os = "macos"))]
        let _ = pending_count;

        #[cfg(target_os = "macos")]
        {
            if pending_count > 0 && !focused {
                let _ = win.set_badge_label(Some(pending_count.to_string()));
            } else {
                let _ = win.set_badge_label(None::<String>);
            }
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
