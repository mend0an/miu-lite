// Windows: Win32 for the widget window and the cursor; files next to the exe
// (portable) or under %APPDATA%.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use tauri::{AppHandle, Manager, WebviewWindow};

use ::windows::Win32::Foundation::{HWND, POINT};
use ::windows::Win32::System::SystemInformation::GetLocalTime;
use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

use super::LocalTime;
use crate::widget::WINDOW_LABEL;

/// Fallback folder name under %APPDATA% / %LOCALAPPDATA%, when the exe sits
/// somewhere it cannot write (Program Files, a read-only share). Not "Miu",
/// so the Lite build never shares preferences with the full app.
const APP_DIR: &str = "MiuLite";
/// Portable data folder, next to the exe.
const PORTABLE_DIR: &str = "MiuLite-data";

/// Keeps spawned helpers from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Files ─────────────────────────────────────────────────────────────────────

fn appdata() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// %LOCALAPPDATA%.
pub fn local_appdata() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// <exe folder>MiuLite-data when it can be written to, else None. Decided
/// once per run, so settings and the log never end up in two places.
pub fn portable_dir() -> Option<PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::current_exe().ok()?.parent()?.join(PORTABLE_DIR);
        std::fs::create_dir_all(&dir).ok()?;
        let probe = dir.join(".write-test");
        std::fs::write(&probe, b"ok").ok()?;
        let _ = std::fs::remove_file(&probe);
        Some(dir)
    })
    .clone()
}

/// Preferences: the portable folder, or %APPDATA%MiuLite.
pub fn config_dir() -> PathBuf {
    portable_dir().unwrap_or_else(|| appdata().join(APP_DIR))
}

/// The log: the portable folder, or %LOCALAPPDATA%MiuLite.
pub fn local_dir() -> PathBuf {
    portable_dir().unwrap_or_else(|| local_appdata().join(APP_DIR))
}

/// %USERPROFILE%.
pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// %APPDATA% and %LOCALAPPDATA% are already private to the user.
pub fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

pub fn local_time() -> LocalTime {
    let t = unsafe { GetLocalTime() };
    LocalTime {
        year: t.wYear.into(),
        month: t.wMonth.into(),
        day: t.wDay.into(),
        hour: t.wHour.into(),
        minute: t.wMinute.into(),
        second: t.wSecond.into(),
    }
}

// ── Processes ─────────────────────────────────────────────────────────────────

/// Spawned helpers must never flash a console window.
pub fn no_console(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

pub fn open_url(url: &str) {
    let _ = no_console(Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]))
        .spawn();
}

/// Windows' own folder picker, modal to `owner`. COM dialogs want a
/// single-threaded apartment, so it runs on a thread of its own. None when
/// the user cancels.
pub fn pick_folder(owner: Option<&WebviewWindow>, start: Option<PathBuf>, title: &str) -> Option<PathBuf> {
    // HWND is not Send: hand the raw value to the dialog thread.
    let owner = owner.and_then(hwnd_of).map(|h| h.0 as isize);
    let title = title.to_string();
    std::thread::spawn(move || unsafe {
        use ::windows::core::HSTRING;
        use ::windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        };
        use ::windows::Win32::UI::Shell::{
            FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName,
            FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
        };

        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let picked = (|| -> ::windows::core::Result<Option<PathBuf>> {
            let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            dialog.SetOptions(dialog.GetOptions()? | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM)?;
            dialog.SetTitle(&HSTRING::from(title.as_str()))?;
            if let Some(start) = start.filter(|p| p.is_dir()) {
                let start: Result<IShellItem, _> = SHCreateItemFromParsingName(&HSTRING::from(start.as_os_str()), None);
                if let Ok(item) = start {
                    let _ = dialog.SetFolder(&item);
                }
            }
            // Cancel comes back as an error HRESULT.
            if dialog.Show(owner.map(|h| HWND(h as *mut _))).is_err() {
                return Ok(None);
            }
            let name = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = name.to_string().ok().map(PathBuf::from);
            CoTaskMemFree(Some(name.0 as *const _));
            Ok(path)
        })();
        if com {
            CoUninitialize();
        }
        picked.ok().flatten()
    })
    .join()
    .ok()
    .flatten()
}

/// Opens Explorer with the file selected. Explorer parses `/select,` itself, so
/// the path goes in as one raw, quoted argument rather than through Rust's quoting.
pub fn reveal_file(path: &Path) {
    let arg = format!("/select,\"{}\"", path.display());
    let _ = Command::new("explorer").raw_arg(arg).spawn();
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// Cursor position in physical screen pixels.
pub fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

/// True while the left mouse button is held — the only signal we get that a
/// drag might be in flight before it reaches the window.
pub fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

// ── Widget window ─────────────────────────────────────────────────────────────

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// Makes sure files dragged from Explorer reach the app: puts our own drop
/// target on the widget window and every child window (see drop_target.rs).
/// Cheap and idempotent, so it is re-run whenever a drag might be starting.
pub fn ensure_drop_target(app: &AppHandle) {
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else { return };
    let Some(hwnd) = hwnd_of(&win) else { return };
    super::drop_target::install_drop_targets(app, hwnd);
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// widget out of Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// Temporarily allow activation so the chat field can be typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = if activating {
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        } else {
            ex | WS_EX_NOACTIVATE.0 as isize
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}
