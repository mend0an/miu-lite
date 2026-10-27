// Is Spotify playing? Read from Windows' media sessions (the same list the
// volume flyout and the lock screen show), so the character can dance along like the
// macOS app does with Apple Music (Coucou 0.1.3, #144/#153). No audio is
// captured and nothing about the track leaves this module: the page only
// receives `music-playing` true/false when it changes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::{log, widget::WINDOW_LABEL, Shared};

/// How often the session list is read while it matters.
const EVERY: Duration = Duration::from_millis(1500);
/// How often the settings are re-checked while dancing is off.
const IDLE: Duration = Duration::from_secs(3);

/// Last state sent, for a page that subscribes after it was emitted.
static PLAYING: AtomicBool = AtomicBool::new(false);

pub fn playing() -> bool {
    PLAYING.load(Ordering::Relaxed)
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut reader = Reader::new();
        loop {
            // Every character dances (Dinusaurus since rig v0.3), so only the
            // setting decides.
            let wanted = app.state::<Shared>().settings.lock().unwrap().dance_to_music;
            let playing = wanted && reader.spotify_playing();
            if PLAYING.swap(playing, Ordering::Relaxed) != playing {
                let _ = app.emit_to(WINDOW_LABEL, "music-playing", playing);
            }
            std::thread::sleep(if wanted { EVERY } else { IDLE });
        }
    });
}

#[cfg(windows)]
struct Reader {
    manager: Option<windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager>,
    com: bool,
    failed: bool,
}

#[cfg(windows)]
impl Reader {
    fn new() -> Self {
        Self { manager: None, com: false, failed: false }
    }

    /// True when any Spotify session (desktop or Microsoft Store app) is playing.
    fn spotify_playing(&mut self) -> bool {
        use windows::Media::Control::{
            GlobalSystemMediaTransportControlsSessionManager as Manager,
            GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
        };
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

        if !self.com {
            // WinRT needs the calling thread in an apartment; this thread is ours.
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            self.com = true;
        }
        if self.manager.is_none() {
            match Manager::RequestAsync().and_then(|op| op.join()) {
                Ok(m) => self.manager = Some(m),
                Err(err) => {
                    if !self.failed {
                        log::line(format!("media sessions unavailable: {err}"));
                        self.failed = true;
                    }
                    return false;
                }
            }
        }
        let Some(manager) = self.manager.as_ref() else { return false };
        let Ok(sessions) = manager.GetSessions() else { return false };
        let count = sessions.Size().unwrap_or(0);
        for i in 0..count {
            let Ok(session) = sessions.GetAt(i) else { continue };
            let is_spotify = session
                .SourceAppUserModelId()
                .map(|id| id.to_string().to_lowercase().contains("spotify"))
                .unwrap_or(false);
            if !is_spotify {
                continue;
            }
            let playing = session
                .GetPlaybackInfo()
                .and_then(|info| info.PlaybackStatus())
                .map(|status| status == Status::Playing)
                .unwrap_or(false);
            if playing {
                return true;
            }
        }
        false
    }
}

#[cfg(not(windows))]
struct Reader;

#[cfg(not(windows))]
impl Reader {
    fn new() -> Self {
        Self
    }

    fn spotify_playing(&mut self) -> bool {
        false
    }
}
