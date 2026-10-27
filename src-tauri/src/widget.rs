// Widget window: placement at the bottom-right of the work area, click-through
// outside the character and the panel, and the cursor poll.
//
// Adapted from Coucou's island.rs. The island lived at the top centre of the
// screen and shrank to a wake strip; the widget instead keeps one fixed-size,
// transparent, always-on-top window glued to the bottom-right corner of the work
// area (the screen minus the taskbar, wherever the taskbar is), and draws the
// character and the panel inside it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::platform::{self, cursor_physical, left_button_down};

/// Smallest logical size of the window: room for the default panel above the
/// character. A chat panel resized larger (the page asks, see resize) grows it.
pub const WINDOW_W: f64 = 380.0;
pub const WINDOW_H: f64 = 600.0;
/// The window's current logical size.
static SIZE: Mutex<(f64, f64)> = Mutex::new((WINDOW_W, WINDOW_H));

pub fn size() -> (f64, f64) {
    *SIZE.lock().unwrap()
}
/// Gap between the window and the edges of the work area, logical px.
const EDGE_MARGIN: f64 = 8.0;

pub const WINDOW_LABEL: &str = "widget";

/// Margin around each hit rect that still takes the mouse, logical px.
const HIT_MARGIN: f64 = 6.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// A shape that takes the mouse (the character, the panel), in window-logical
/// coordinates, pushed by the front end.
#[derive(Clone, Copy, Default, Deserialize)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl HitRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        self.w > 0.0
            && x >= self.x - HIT_MARGIN
            && x <= self.x + self.w + HIT_MARGIN
            && y >= self.y - HIT_MARGIN
            && y <= self.y + self.h + HIT_MARGIN
    }
}

/// Wakes / parks the cursor poll thread so a hidden widget costs nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub rects: Mutex<Vec<HitRect>>,
    /// Mirrors the window flag so we only call into the OS when it changes.
    ignoring: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            rects: Mutex::new(Vec::new()),
            ignoring: AtomicBool::new(false),
        }
    }

    pub fn set_rects(&self, rects: Vec<HitRect>) {
        *self.rects.lock().unwrap() = rects;
    }

    /// Forces the next poll tick to re-apply the flag (after a move or resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// The display the widget lives on: the primary one, or the one under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let wa = m.work_area();
            ScreenInfo {
                x: wa.position.x as f64 / scale,
                y: wa.position.y as f64 / scale,
                width: wa.size.width as f64 / scale,
                height: wa.size.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0, scale: 1.0 },
    }
}

/// Glues the window to the bottom-right corner of the work area. The work area
/// already excludes the taskbar, wherever it is docked; an auto-hidden taskbar
/// leaves the work area full-height, so the widget sits just above the edge.
pub fn apply_geometry(app: &AppHandle, pref: &str) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };

    let scale = m.scale_factor();
    let wa = m.work_area();

    let (w, h) = fit(size(), &m);
    let pw = (w * scale).round().max(1.0) as u32;
    let ph = (h * scale).round().max(1.0) as u32;
    let margin = (EDGE_MARGIN * scale).round() as i32;
    let x = wa.position.x + wa.size.width as i32 - pw as i32 - margin;
    let y = wa.position.y + wa.size.height as i32 - ph as i32 - margin;

    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);
}

/// A window size between the minimum and the work area of the monitor.
fn fit((w, h): (f64, f64), m: &Monitor) -> (f64, f64) {
    let scale = m.scale_factor();
    let wa = m.work_area();
    let max_w = (wa.size.width as f64 / scale - 2.0 * EDGE_MARGIN).max(WINDOW_W);
    let max_h = (wa.size.height as f64 / scale - 2.0 * EDGE_MARGIN).max(WINDOW_H);
    let pick = |v: f64, min: f64, max: f64| if v.is_finite() { v.round().clamp(min, max) } else { min };
    (pick(w, WINDOW_W, max_w), pick(h, WINDOW_H, max_h))
}

/// Resizes the window (logical px) for a resized chat panel. The page moves
/// it afterwards, so the character keeps its spot on screen. Returns the
/// size actually used, after fitting it to the work area.
pub fn resize(app: &AppHandle, pref: &str, w: f64, h: f64) -> (f64, f64) {
    let fitted = match target_monitor(app, pref) {
        Some(m) => fit((w, h), &m),
        None => (w.max(WINDOW_W), h.max(WINDOW_H)),
    };
    *SIZE.lock().unwrap() = fitted;
    if let Some(win) = window(app) {
        let _ = win.set_size(tauri::LogicalSize::new(fitted.0, fitted.1));
    }
    fitted
}

/// Puts the window's top-left at a logical screen position. The page decides
/// where (it keeps the window inside the work area while the user drags the
/// character around).
pub fn move_to(app: &AppHandle, x: f64, y: f64) {
    let Some(win) = window(app) else { return };
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
}

/// Work area and scale of the monitor the widget lives on. Any change here —
/// display plugged in, rescaled, taskbar moved — means placing it again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let wa = m.work_area();
    Some((
        wa.position.x,
        wa.position.y,
        wa.size.width,
        wa.size.height,
        m.scale_factor().to_bits(),
    ))
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the widget is
/// shown, and flips click-through from the pushed hit rects. Parked on a condvar
/// while the widget is hidden.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        loop {
            gate.wait_until_active();
            let mut last = (f64::MIN, f64::MIN);
            let mut ticks: u32 = 0;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(16));

                // About twice a second: has the work area changed under us?
                ticks = ticks.wrapping_add(1);
                if ticks % 30 == 0 {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::log::line("work area changed — repositioning".to_string());
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let Some((cx, cy)) = cursor_physical() else { continue };
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;

                // A press may be the start of a file drag: make sure the drop
                // target is ours before the file arrives (see platform).
                let down = left_button_down();
                if down && !was_down {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || platform::ensure_drop_target(&handle));
                }
                was_down = down;

                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                // Click-through: the window only takes the mouse over the shapes
                // the page reported. While a button is held over the window the
                // whole window accepts it, because WS_EX_TRANSPARENT hides the
                // window from OLE and a dragged file would find no drop target.
                let on_shape = gate.rects.lock().unwrap().iter().any(|r| r.contains(x, y));
                let (w, h) = size();
                let dragging = down && x >= 0.0 && x <= w && y >= 0.0 && y <= h;

                let accept = on_shape || dragging;
                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    let _ = win.set_ignore_cursor_events(!accept);
                }

                let _ = win.emit("cursor", CursorPayload { x, y });
            }
        }
    });
}

/// Re-applies click-through after the window or its shapes changed: the window
/// takes the mouse again and the next poll tick decides from the cursor.
pub fn refresh_click_through(app: &AppHandle, gate: &PollGate) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(false);
    }
    gate.forget_ignore_state();
}

/// Tray → Show / Hide. A hidden widget parks the cursor poll entirely.
pub fn set_visible(app: &AppHandle, gate: &PollGate, visible: bool) {
    let Some(win) = window(app) else { return };
    if visible {
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        refresh_click_through(app, gate);
        gate.set_active(true);
    } else {
        gate.set_active(false);
        let _ = win.hide();
    }
    let _ = app.emit_to(WINDOW_LABEL, "visibility", visible);
}

pub fn is_visible(app: &AppHandle) -> bool {
    window(app).and_then(|w| w.is_visible().ok()).unwrap_or(false)
}
