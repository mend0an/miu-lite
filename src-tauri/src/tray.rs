// Notification-area icon: left click opens the chat; the menu has Open chat,
// Show/Hide, Stop, Settings and Quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::widget::{self, WINDOW_LABEL};

const TOOLTIP: &str = "Miu Lite — klik untuk chat";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let chat = MenuItem::with_id(app, "chat", "Buka chat\tCtrl+Alt+D", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Tampilkan / sembunyikan", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Pengaturan…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&chat, &toggle, &stop, &sep1, &settings, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("miu-lite")
        .tooltip(TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "chat" => open_chat(app, false),
            "toggle" => toggle_widget(app),
            "stop" => crate::llm::stop(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_chat(tray.app_handle(), false);
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// Shows the widget if it was hidden, then asks the page to open the chat
/// panel (`toggle`: close it again if it is already open — the shortcut).
pub fn open_chat(app: &AppHandle, toggle: bool) {
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    let was_hidden = !widget::is_visible(app);
    if was_hidden {
        widget::set_visible(app, &shared.gate, true);
    }
    let mode = if toggle && !was_hidden { "toggle" } else { "open" };
    let _ = app.emit_to(WINDOW_LABEL, "open-chat", mode);
}

fn toggle_widget(app: &AppHandle) {
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    let visible = widget::is_visible(app);
    widget::set_visible(app, &shared.gate, !visible);
}
