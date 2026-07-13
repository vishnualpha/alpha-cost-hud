mod keychain;
mod local_agents;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};

#[cfg(target_os = "macos")]
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt,
};

// A real macOS NSPanel subclass. `can_become_key_window: false` means the panel
// never takes key status, so clicking it can't pull focus. (If the HUD ever
// needs text input, flip this to true — the nonactivating mask still keeps the
// user's app frontmost.)
#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(HudPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true,
            hides_on_deactivate: false
        }
    })
}

/// Make the HUD a true heads-up overlay: clicking it never activates our app,
/// so the user's editor stays frontmost. Tauri has no built-in for this —
/// `focusable: false` only skips *initial* focus, it does not prevent activation.
#[cfg(target_os = "macos")]
fn make_hud_nonactivating(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("hud")
        .ok_or("hud window missing")?;
    let panel = window.to_panel::<HudPanel>()?;

    panel.set_level(PanelLevel::Floating.value());

    // NOTE: `.borderless()` ASSIGNS the mask (it doesn't OR), so it must come
    // first or it would wipe the nonactivating bit.
    panel.set_style_mask(StyleMask::empty().borderless().nonactivating_panel().into());

    // Stay visible across Spaces and alongside a fullscreen editor; stay out of
    // Cmd-Tab. Without these a HUD vanishes exactly when it's most useful.
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .can_join_all_spaces()
            .stationary()
            .ignores_cycle()
            .full_screen_auxiliary()
            .value(),
    );
    panel.set_becomes_key_only_if_needed(true);

    // CRITICAL: AppKit only syncs the WindowServer's "prevents activation" tag
    // during NSPanel *init*. We class-swap an already-initialized NSWindow, so
    // the style-mask bit alone is a no-op — this private call is what actually
    // makes clicking the HUD stop activating our app.
    unsafe {
        use objc2::msg_send;
        use objc2_app_kit::NSPanel;
        let ptr = window.ns_window()? as *mut NSPanel;
        let _: () = msg_send![&*ptr, _setPreventsActivation: true];
    }

    Ok(())
}

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

/// Show the HUD. Deliberately does NOT call set_focus() — this is a heads-up
/// overlay, so surfacing it must never pull the user out of their current app.
fn show_hud(window: &WebviewWindow) {
    let _ = window.show();
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
    let builder = tauri::Builder::default();

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
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
                    // locked out, and surface the HUD (without stealing focus).
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(win) = app.get_webview_window("hud") {
                            let _ = win.set_ignore_cursor_events(false);
                            let _ = win.show();
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

            // Convert to a non-activating NSPanel BEFORE anything shows/focuses
            // it, so the HUD never steals focus from the user's app.
            #[cfg(target_os = "macos")]
            if let Err(e) = make_hud_nonactivating(app.handle()) {
                eprintln!("non-activating panel setup failed: {e}");
            }

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
