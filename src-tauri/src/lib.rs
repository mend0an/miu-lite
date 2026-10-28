// Miu Lite — app wiring and the commands the pages call.
//
// Portable Gemini companion using the Miu v0.4 layered artwork.
// Derived MIT code is attributed in LICENSE and THIRD_PARTY_NOTICES.md.

mod files;
mod gemini;
mod providers;
mod llm;
mod log;
mod media;
mod memory;
mod platform;
mod secrets;
mod settings;
mod tray;
mod widget;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Opens or closes the chat panel from anywhere.
fn chat_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD)
}

use llm::{Chat, ModelInfo};
use settings::Settings;
use widget::{HitRect, PollGate, ScreenInfo};

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    drop_root: String,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let settings = shared.settings.lock().unwrap().clone();
    let screen = widget::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        drop_root: files::root_dir().to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) -> Result<(), String> {
    settings::save(&settings).map_err(|e| format!("Gagal menyimpan pengaturan: {e}"))?;
    let (screen_changed, autostart_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        *current = settings.clone();
        (screen_changed, autostart_changed)
    };
    // Not keeping the chat any more: the saved one goes now, not at next exit.
    if !settings.keep_chat {
        memory::save_chat(&[]);
    }
    files::set_root(&settings.drop_root);
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            log::line(format!("autostart: {err}"));
        }
    }
    if screen_changed {
        widget::apply_geometry(&app, &settings.screen);
    }
    // Keep the other window in step (widget ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
    Ok(())
}

/// The page pushes the shapes that take the mouse; Rust decides click-through.
#[tauri::command]
fn set_hit_rects(shared: State<Shared>, rects: Vec<HitRect>) {
    shared.gate.set_rects(rects);
}

/// The chat field needs keyboard focus; everything else must not take it.
#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = widget::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    widget::apply_geometry(&app, &pref);
    widget::refresh_click_through(&app, &shared.gate);
}

/// The page moves the window while the character is dragged.
#[tauri::command]
fn move_widget(app: AppHandle, x: f64, y: f64) {
    widget::move_to(&app, x, y);
}

/// The chat panel was resized: the window grows or shrinks with it. Returns
/// the logical size used (never below 380 × 600, never beyond the screen).
#[tauri::command]
fn resize_widget(app: AppHandle, shared: State<Shared>, w: f64, h: f64) -> (f64, f64) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let size = widget::resize(&app, &pref, w, h);
    widget::refresh_click_through(&app, &shared.gate);
    size
}

/// Work area of the widget's display, for placing it again after a change.
#[tauri::command]
fn screen_info(app: AppHandle, shared: State<Shared>) -> ScreenInfo {
    let pref = shared.settings.lock().unwrap().screen.clone();
    widget::screen_info(&app, &pref)
}

#[tauri::command]
fn hide_widget(app: AppHandle, shared: State<Shared>) {
    widget::set_visible(&app, &shared.gate, false);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Lets the pages write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

/// Whether Spotify is playing right now (also sent as `music-playing` events).
#[tauri::command]
fn music_playing() -> bool {
    media::playing()
}

// ── Gemini ─────────────────────────────────────────────────────────────────────

/// Starts a streaming turn; the answer arrives as `chat` events.
#[tauri::command]
fn chat_send(app: AppHandle, chat: State<Chat>, text: String) -> Result<u64, String> {
    llm::send(&app, &chat, text)
}

#[tauri::command]
fn chat_stop(app: AppHandle) {
    llm::stop(&app);
}

#[tauri::command]
fn chat_reset(app: AppHandle) {
    llm::reset(&app);
}

/// The conversation so far (restored from chat.json at launch).
#[tauri::command]
fn chat_history(chat: State<Chat>) -> Vec<llm::Turn> {
    chat.history()
}

/// Models offered by the configured provider (save the settings first).
#[tauri::command]
async fn llm_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    llm::list_models(&app).await
}

#[tauri::command]
async fn llm_test(app: AppHandle) -> Result<String, String> {
    llm::test(&app).await
}

/// Checks a base URL the way requests will (https, or http on a local network).
#[tauri::command]
fn llm_check_url(url: String) -> Result<String, String> {
    llm::validate_base(&url)
}

// ── Memory ────────────────────────────────────────────────────────────────────

#[tauri::command]
fn memory_list() -> Vec<memory::Fact> {
    memory::list()
}

#[tauri::command]
fn memory_forget(app: AppHandle, id: u32) -> Result<(), String> {
    memory::forget(id)?;
    llm::memory_changed(&app);
    Ok(())
}

#[tauri::command]
fn memory_clear(app: AppHandle) -> Result<(), String> {
    memory::clear()?;
    llm::memory_changed(&app);
    Ok(())
}

// ── Files ─────────────────────────────────────────────────────────────────────

#[tauri::command]
fn files_plan(paths: Vec<String>) -> files::Plan {
    files::plan(&paths)
}

/// Copying can take a while: off the main thread.
#[tauri::command]
async fn files_copy(paths: Vec<String>) -> Result<Vec<files::CopyResult>, String> {
    tauri::async_runtime::spawn_blocking(move || files::copy(&paths))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn files_reveal(path: String) -> Result<(), String> {
    files::reveal(&path)
}

/// Where dropped files go right now (the `dropRoot` setting or the default).
#[tauri::command]
fn files_root() -> String {
    files::root_dir().to_string_lossy().to_string()
}

/// Folder picker for the drop folder, over the settings window. Only picks:
/// the page saves the choice as `dropRoot`. None when cancelled.
#[tauri::command]
async fn pick_drop_folder(app: AppHandle) -> Option<String> {
    let start = files::root_dir();
    tauri::async_runtime::spawn_blocking(move || {
        let owner = app.get_webview_window("settings");
        platform::pick_folder(owner.as_ref(), Some(start), "Pilih folder penampungan file")
    })
    .await
    .ok()
    .flatten()
    .map(|p| p.to_string_lossy().to_string())
}

// ── Secrets ───────────────────────────────────────────────────────────────────

/// The pages may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, value.trim())
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the widget (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI --autoplay-policy=no-user-gesture-required";

fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// Created hidden at launch and only ever shown and hidden afterwards: a
/// WebView2 window created later silently comes up blank (found in Coucou).
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Pengaturan — Miu Lite")
        .inner_size(560.0, 640.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    let loaded = settings::load();
    files::set_root(&loaded.drop_root);
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(shared) = app.try_state::<Shared>() {
                widget::set_visible(app, &shared.gate, true);
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && *shortcut == chat_shortcut() {
                        tray::open_chat(app, true);
                    }
                })
                .build(),
        )
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        // The conversation from before the last exit, when it is kept.
        .manage(if loaded.keep_chat { Chat::with_history(memory::load_chat()) } else { Chat::default() })
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_hit_rects,
            focus_window,
            reposition,
            move_widget,
            resize_widget,
            screen_info,
            hide_widget,
            open_url,
            quit_app,
            log_line,
            music_playing,
            chat_send,
            chat_stop,
            chat_reset,
            chat_history,
            memory_list,
            memory_forget,
            memory_clear,
            llm_models,
            llm_test,
            llm_check_url,
            files_plan,
            files_copy,
            files_reveal,
            files_root,
            pick_drop_folder,
            secret_present,
            secret_set,
            secret_clear,
            open_settings_window,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the widget: see create_settings_window.
            create_settings_window(&handle);

            if let Some(win) = widget::window(&handle) {
                platform::make_non_activating(&win);
                widget::apply_geometry(&handle, &loaded.screen);
                let _ = win.show();
            }
            widget::refresh_click_through(&handle, &gate);
            gate.set_active(true);
            widget::spawn_cursor_poll(handle.clone(), gate.clone());

            // WebView2 creates its render widget once the page has loaded:
            // put our drop target on it then (the cursor poll also re-runs
            // this on every mouse press).
            let drops = handle.clone();
            std::thread::spawn(move || {
                for delay in [800u64, 2500, 6000] {
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                    let h = drops.clone();
                    let _ = drops.run_on_main_thread(move || platform::ensure_drop_target(&h));
                }
            });

            media::start(handle.clone());

            // Ctrl+Alt+D opens / closes the chat from anywhere. Another app may
            // already own it: then the chat is still one tray click away.
            if let Err(err) = handle.global_shortcut().register(chat_shortcut()) {
                log::line(format!("shortcut Ctrl+Alt+D unavailable: {err}"));
            }

            log::line(format!("--- Miu Lite {} started ---", env!("CARGO_PKG_VERSION")));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Miu Lite");
}
