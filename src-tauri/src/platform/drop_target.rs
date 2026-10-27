// The widget's own OLE drop target.
//
// Coucou relied on wry's drop target and revoked the one WebView2 registers on
// its render widget, hoping OLE would fall through to wry's. On the widget that
// chain broke and Explorer showed the "no drop" cursor. So the app registers
// its own IDropTarget on the widget window and on every child window, replacing
// whatever WebView2 or wry put there, and reports drags as `file-drag` events.
//
// RegisterDragDrop keeps its own reference to the target and RevokeDragDrop
// releases it, so nothing has to be kept alive here.

use std::cell::Cell;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use ::windows::core::{implement, Ref, BOOL};
use ::windows::Win32::Foundation::{HWND, LPARAM, POINTL};
use ::windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use ::windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP,
    DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use ::windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use ::windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use ::windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

use crate::widget::WINDOW_LABEL;

#[derive(Serialize, Clone)]
struct FileDrag {
    /// "enter" | "leave" | "drop"
    #[serde(rename = "type")]
    kind: &'static str,
    paths: Vec<String>,
}

fn emit(app: &AppHandle, kind: &'static str, paths: Vec<String>) {
    let _ = app.emit_to(WINDOW_LABEL, "file-drag", FileDrag { kind, paths });
}

/// The file paths in a drag, or None when it carries no files (text, a link…).
fn read_paths(data: &IDataObject) -> Option<Vec<String>> {
    let format = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let mut medium = unsafe { data.GetData(&format) }.ok()?;
    let hdrop = HDROP(unsafe { medium.u.hGlobal.0 });
    let count = unsafe { DragQueryFileW(hdrop, u32::MAX, None) };
    let mut paths = Vec::with_capacity(count as usize);
    for i in 0..count {
        let len = unsafe { DragQueryFileW(hdrop, i, None) } as usize;
        let mut buf = vec![0u16; len + 1];
        unsafe { DragQueryFileW(hdrop, i, Some(&mut buf)) };
        paths.push(String::from_utf16_lossy(&buf[..len]));
    }
    unsafe { ReleaseStgMedium(&mut medium) };
    (!paths.is_empty()).then_some(paths)
}

#[implement(IDropTarget)]
struct FileDropTarget {
    app: AppHandle,
    /// The drag in progress carries files.
    valid: Cell<bool>,
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for FileDropTarget_Impl {
    fn DragEnter(
        &self,
        data: Ref<IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> ::windows::core::Result<()> {
        let paths = data.as_ref().and_then(read_paths);
        self.valid.set(paths.is_some());
        unsafe { *effect = if paths.is_some() { DROPEFFECT_COPY } else { DROPEFFECT_NONE } };
        if let Some(paths) = paths {
            emit(&self.app, "enter", paths);
        }
        Ok(())
    }

    fn DragOver(&self, _keys: MODIFIERKEYS_FLAGS, _pt: &POINTL, effect: *mut DROPEFFECT) -> ::windows::core::Result<()> {
        unsafe { *effect = if self.valid.get() { DROPEFFECT_COPY } else { DROPEFFECT_NONE } };
        Ok(())
    }

    fn DragLeave(&self) -> ::windows::core::Result<()> {
        if self.valid.replace(false) {
            emit(&self.app, "leave", Vec::new());
        }
        Ok(())
    }

    fn Drop(
        &self,
        data: Ref<IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> ::windows::core::Result<()> {
        self.valid.set(false);
        match data.as_ref().and_then(read_paths) {
            Some(paths) => {
                unsafe { *effect = DROPEFFECT_COPY };
                emit(&self.app, "drop", paths);
            }
            None => {
                unsafe { *effect = DROPEFFECT_NONE };
                emit(&self.app, "leave", Vec::new());
            }
        }
        Ok(())
    }
}

unsafe extern "system" fn collect_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
    list.push(hwnd);
    true.into()
}

/// Puts our drop target on `root` and all its child windows. WebView2 creates
/// its render widget after the page loads and may register its own target
/// again later, so this is re-run whenever a drag might be starting. Must run
/// on the main (OLE) thread.
pub fn install_drop_targets(app: &AppHandle, root: HWND) {
    let mut windows = vec![root];
    unsafe {
        let _ = EnumChildWindows(
            Some(root),
            Some(collect_child),
            LPARAM(&mut windows as *mut Vec<HWND> as isize),
        );
    }
    let target: IDropTarget = FileDropTarget { app: app.clone(), valid: Cell::new(false) }.into();
    for hwnd in windows {
        unsafe {
            let _ = RevokeDragDrop(hwnd);
            let _ = RegisterDragDrop(hwnd, &target);
        }
    }
}
