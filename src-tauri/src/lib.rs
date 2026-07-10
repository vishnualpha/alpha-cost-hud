mod keychain;
mod local_agents;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};

/// Toggle whether the HUD lets clicks pass through to whatever is behind it.
/// When ignore=true the widget floats over your work without stealing clicks.
#[tauri::command]
fn set_click_through(window: WebviewWindow, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

/// Fully quit the app (used by the in-window Quit button and tray Quit).
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Show + focus the HUD (used by the tray "Show" item and left-click).
fn show_hud(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

fn toggle_hud(window: &WebviewWindow) {
    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        _ => show_hud(window),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        // Persists + restores window size and position across launches. Save on
        // every move/resize (not just on exit) so a killed process still keeps
        // the latest geometry. SKIP_TASKBAR/VISIBLE are excluded so a hidden HUD
        // doesn't restore hidden.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION,
                )
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("CmdOrCtrl+Alt+H")
                .expect("valid shortcut")
                .with_handler(|app, _shortcut, event| {
                    // Panic button: force click-through OFF so you can never get
                    // locked out. Also shows + focuses the window.
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(win) = app.get_webview_window("hud") {
                            let _ = win.set_ignore_cursor_events(false);
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            set_click_through,
            quit_app,
            keychain::save_api_key,
            keychain::get_api_key,
            keychain::clear_api_key,
            keychain::save_provider_key,
            keychain::get_provider_key,
            keychain::clear_provider_key,
            local_agents::read_local_agents,
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("hud")
                .expect("hud window must exist");

            // The window-state plugin owns size + position after the first run.
            // But a restored position can land off-screen (e.g. a monitor that's
            // no longer connected), leaving the window invisible. Clamp it back
            // onto the current monitor so it can never get stranded.
            if let (Ok(pos), Ok(size), Ok(Some(monitor))) = (
                window.outer_position(),
                window.outer_size(),
                window.current_monitor(),
            ) {
                let m = monitor.size();
                let mp = monitor.position();
                let max_x = mp.x + m.width as i32 - size.width as i32;
                let max_y = mp.y + m.height as i32 - size.height as i32;
                let clamped_x = pos.x.clamp(mp.x, max_x.max(mp.x));
                let clamped_y = pos.y.clamp(mp.y, max_y.max(mp.y));
                if clamped_x != pos.x || clamped_y != pos.y {
                    let _ = window
                        .set_position(tauri::PhysicalPosition::new(clamped_x, clamped_y));
                }
            }
            show_hud(&window);

            // Tray icon: left-click toggles the HUD, menu offers Show/Quit.
            let show_i = MenuItem::with_id(app, "show", "Show HUD", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let win_for_menu = window.clone();
            TrayIconBuilder::with_id("hud-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Alpha Cost HUD")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_hud(&win_for_menu),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("hud") {
                            toggle_hud(&window);
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Alpha Cost HUD");
}
