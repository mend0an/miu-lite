// No console window in release builds: the widget and the tray icon are the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    miu_lite_lib::run()
}
