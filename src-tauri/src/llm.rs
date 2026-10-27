// LLM layer: one chat, one Stop, one set of errors. Miu Lite talks to Google
// Gemini only, on its native API (gemini.rs) — no n8n.
//
// The page only ever sees text deltas and status events. The key stays in the
// Credential Manager and only leaves in a request header. The conversation is
// kept here, sent whole on every turn, and saved to chat.json after each one
// (memory.rs), so a restart or a shutdown loses nothing.
//
// With memory on, the facts Miu keeps about the user go into the system
// prompt, Gemini may save or forget facts with two tools, and conversations are
// summarised into facts: when a new one starts, and when the history overflows
// (the oldest messages are summarised before they are dropped).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::{gemini, log, memory, platform, secrets, widget::WINDOW_LABEL};

pub const GEMINI_KEY: &str = "gemini-api-key";
pub const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";
/// Waiting for the response headers.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest silence allowed between two stream chunks.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Messages kept in the conversation sent to the model. Past that, the oldest
/// go to a summary until KEEP_HISTORY are left (both even: user + model pairs).
const MAX_HISTORY: usize = 40;
const KEEP_HISTORY: usize = 24;
/// Rounds of tool calls in one turn; the round after that must answer in text.
pub const MAX_TOOL_ROUNDS: usize = 4;
/// A summary is background work: give up rather than hang around.
const SUMMARY_LIMIT: Duration = Duration::from_secs(60);

const PERSONA: &str = "Kamu adalah Miu, asisten yang ramah dan menjadi \
pendamping desktop pengguna di Windows. Jawab dalam bahasa yang dipakai pengguna. Jawab dengan jelas \
dan secukupnya. Gunakan teks biasa tanpa format Markdown (tanpa **, #, atau tabel); boleh memakai \
baris baru dan daftar bernomor sederhana. Selain mengobrol (dan mengelola ingatanmu sendiri kalau \
alatnya tersedia), kamu tidak bisa membuka aplikasi, membaca atau mengubah file, atau menjalankan aksi \
apa pun di komputer pengguna, jadi jangan pernah mengaku sudah melakukannya.";

// ── Provider ──────────────────────────────────────────────────────────────────

/// Everything a request needs, read fresh from settings and the keychain.
#[derive(Clone)]
pub struct Provider {
    /// No trailing slash.
    pub base: String,
    pub key: String,
    pub model: String,
}

/// http:// only for this machine and private networks (a proxy on the LAN);
/// anything on the internet must be https, or the key would travel in the clear.
pub fn validate_base(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/').to_string();
    let rest = if let Some(r) = url.strip_prefix("https://") {
        r
    } else if let Some(r) = url.strip_prefix("http://") {
        let host = r.split(['/', ':']).next().unwrap_or("");
        let octet = |i: usize| host.split('.').nth(i).and_then(|o| o.parse::<u8>().ok());
        let private = host == "localhost"
            || host.starts_with("127.")
            || host == "[::1]"
            || host.starts_with("10.")
            || host.starts_with("192.168.")
            || (host.starts_with("172.") && octet(1).is_some_and(|o| (16..=31).contains(&o)))
            // 100.64.0.0/10: Tailscale (carrier-grade NAT range).
            || (host.starts_with("100.") && octet(1).is_some_and(|o| (64..=127).contains(&o)));
        if !private {
            return Err("Gunakan https:// untuk server di internet. http:// hanya untuk localhost atau jaringan lokal.".into());
        }
        r
    } else {
        return Err("URL harus diawali http:// atau https://".into());
    };
    if rest.is_empty() || rest.contains(char::is_whitespace) {
        return Err("URL tidak valid.".into());
    }
    Ok(url)
}

/// Gemini as configured in settings. `need_model` false for listing models.
fn provider(app: &AppHandle, need_model: bool) -> Result<Provider, String> {
    let (base, model) = {
        let shared = app.state::<crate::Shared>();
        let s = shared.settings.lock().unwrap();
        (s.llm_base_url.clone(), s.model.clone())
    };
    let base = if base.trim().is_empty() { GEMINI_BASE.to_string() } else { validate_base(&base)? };
    let key = secrets::get(GEMINI_KEY).ok_or("API key Gemini belum diisi. Buka Pengaturan.")?;
    let model = if need_model {
        if model.trim().is_empty() {
            return Err("Belum ada model. Pilih model di Pengaturan.".into());
        }
        gemini::normalize_model(&model)?
    } else {
        model
    };
    Ok(Provider { base, key, model })
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

// ── Errors and events ─────────────────────────────────────────────────────────

pub struct Failure {
    pub message: String,
    pub code: &'static str,
}

pub fn failure(code: &'static str, message: impl Into<String>) -> Failure {
    Failure { message: message.into(), code }
}

pub enum Outcome {
    Done { text: String, note: Option<String> },
    Stopped { text: String },
    Failed(Failure),
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatEvent {
    request_id: u64,
    /// "delta" | "tool" | "done" | "stopped" | "error"
    kind: &'static str,
    text: String,
    /// For errors: "key" | "model" | "ratelimit" | "network" | "blocked" | "server" | "other".
    code: Option<&'static str>,
}

pub fn emit(app: &AppHandle, request_id: u64, kind: &'static str, text: String, code: Option<&'static str>) {
    let _ = app.emit_to(WINDOW_LABEL, "chat", ChatEvent { request_id, kind, text, code });
}

/// Splits a growing SSE buffer into complete events and returns their `data:`
/// payloads. CR only ever appears as a line terminator (JSON escapes it), so
/// dropping it turns "\r\n\r\n" into the "\n\n" we split on.
pub fn sse_take(buf: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    buf.extend(chunk.iter().copied().filter(|b| *b != b'\r'));
    let mut out = Vec::new();
    while let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
        let event: Vec<u8> = buf.drain(..pos + 2).collect();
        let data = sse_data(&event);
        if !data.is_empty() {
            out.push(data);
        }
    }
    out
}

pub fn sse_data(event: &[u8]) -> String {
    String::from_utf8_lossy(event)
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// The persona, today's date from the PC clock, and the memory when it is on.
fn system_prompt(memory_on: bool, auto_summary: bool) -> String {
    let t = platform::local_time();
    let mut prompt = format!(
        "{PERSONA} Hari ini {}, {:04}-{:02}-{:02}.",
        weekday(t.year, t.month, t.day),
        t.year,
        t.month,
        t.day
    );
    if memory_on {
        prompt.push_str(&memory::context(auto_summary));
    }
    prompt
}

/// (memory on, auto summary on, keep the chat) from the settings.
fn memory_prefs(app: &AppHandle) -> (bool, bool, bool) {
    let shared = app.state::<crate::Shared>();
    let s = shared.settings.lock().unwrap();
    (s.memory_enabled, s.memory_enabled && s.auto_summary, s.keep_chat)
}

/// Tells the settings window the list of facts changed.
pub fn memory_changed(app: &AppHandle) {
    let _ = app.emit("memory-changed", ());
}

/// Runs one tool call for the provider loop and tells the page about it.
pub fn run_tool(app: &AppHandle, id: u64, name: &str, args: &serde_json::Value) -> serde_json::Value {
    log::line(format!("chat #{id} tool {name}"));
    emit(app, id, "tool", memory::status_text(name).to_string(), None);
    let result = memory::run_tool(name, args);
    if result.get("error").is_none() {
        memory_changed(app);
    }
    result
}

/// Asks Gemini, in the background, which facts of these messages are worth
/// keeping. Quietly does nothing when memory or the summary is off, or when
/// Gemini is not set up.
fn summarize(app: &AppHandle, turns: Vec<Turn>) {
    let (_, auto, _) = memory_prefs(app);
    if !auto || turns.len() < 2 {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(p) = provider(&app, true) else { return };
        let (system, prompt) = memory::summary_request(&turns);
        match gemini::one_shot(&p, &system, &prompt, SUMMARY_LIMIT).await {
            Ok(answer) => {
                let added = memory::apply_summary(&answer);
                log::line(format!("memory: summary of {} messages, {added} new facts", turns.len()));
                if added > 0 {
                    memory_changed(&app);
                }
            }
            Err(e) => log::line(format!("memory: summary failed: {e}")),
        }
    });
}

/// Indonesian day name (Sakamoto's method).
fn weekday(year: u32, month: u32, day: u32) -> &'static str {
    const DAYS: [&str; 7] = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
    const OFFSET: [i64; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let m = month.clamp(1, 12) as usize;
    let y = i64::from(year) - i64::from(m < 3);
    let w = (y + y / 4 - y / 100 + y / 400 + OFFSET[m - 1] + i64::from(day)).rem_euclid(7);
    DAYS[w as usize]
}

// ── Conversation ──────────────────────────────────────────────────────────────

/// One message of the conversation (also its form in chat.json).
#[derive(Clone, Serialize, Deserialize)]
pub struct Turn {
    pub user: bool,
    pub text: String,
}

struct Active {
    id: u64,
    cancel: Arc<Notify>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Chat {
    history: Mutex<Vec<Turn>>,
    active: Mutex<Option<Active>>,
    next_id: AtomicU64,
    /// Bumped by reset(): a turn that started before a reset must not write its
    /// result into the fresh conversation.
    epoch: AtomicU64,
}

impl Chat {
    /// The conversation saved before the last exit.
    pub fn with_history(history: Vec<Turn>) -> Self {
        let chat = Self::default();
        let excess = history.len().saturating_sub(MAX_HISTORY);
        *chat.history.lock().unwrap() = history.into_iter().skip(excess).collect();
        chat
    }

    /// For the page to show the conversation again after a restart.
    pub fn history(&self) -> Vec<Turn> {
        self.history.lock().unwrap().clone()
    }
}

/// Starts one streaming turn and returns its request ID at once. The answer
/// arrives as `chat` events on the widget window.
pub fn send(app: &AppHandle, chat: &Chat, text: String) -> Result<u64, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Pesan kosong.".into());
    }
    let provider = provider(app, true)?;

    let mut active = chat.active.lock().unwrap();
    if active.is_some() {
        return Err("Masih menjawab. Tekan Stop dulu.".into());
    }
    let id = chat.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(Notify::new());
    let cancelled = Arc::new(AtomicBool::new(false));
    *active = Some(Active { id, cancel: cancel.clone(), cancelled: cancelled.clone() });
    drop(active);

    let user = Turn { user: true, text };
    let mut turns = chat.history.lock().unwrap().clone();
    turns.push(user.clone());
    let epoch = chat.epoch.load(Ordering::Relaxed);
    let (memory_on, auto_summary, keep_chat) = memory_prefs(app);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let tools = if memory_on { memory::tool_declarations() } else { Vec::new() };
        let system = system_prompt(memory_on, auto_summary);
        log::line(format!("chat #{id} start Gemini model={} tools={}", provider.model, tools.len()));
        let outcome = gemini::stream(&app, id, &provider, &system, &tools, &turns, &cancel, &cancelled).await;
        let chat = app.state::<Chat>();
        *chat.active.lock().unwrap() = None;
        let same_conversation = chat.epoch.load(Ordering::Relaxed) == epoch;

        let remember = |reply: &str| {
            if !same_conversation || reply.is_empty() {
                return;
            }
            let dropped = {
                let mut history = chat.history.lock().unwrap();
                history.push(user.clone());
                history.push(Turn { user: false, text: reply.to_string() });
                let dropped: Vec<Turn> = if history.len() > MAX_HISTORY {
                    let n = history.len() - KEEP_HISTORY;
                    history.drain(..n).collect()
                } else {
                    Vec::new()
                };
                if keep_chat {
                    memory::save_chat(&history);
                }
                dropped
            };
            summarize(&app, dropped);
        };

        match outcome {
            Outcome::Done { text, note } => {
                remember(&text);
                log::line(format!("chat #{id} done ({} chars)", text.chars().count()));
                emit(&app, id, "done", note.unwrap_or_default(), None);
            }
            Outcome::Stopped { text } => {
                // Keep what was already shown, so the next turn has the same context.
                remember(&text);
                log::line(format!("chat #{id} stopped"));
                emit(&app, id, "stopped", String::new(), None);
            }
            Outcome::Failed(f) => {
                // Gemini's own error text (status, reason) — never the key or the chat.
                log::line(format!("chat #{id} error {}: {}", f.code, f.message));
                emit(&app, id, "error", f.message, Some(f.code));
            }
        }
    });
    Ok(id)
}

/// Stop from the panel, the tray or a shortcut. Stopping is immediate on our
/// side: no further delta reaches the page once this returns.
pub fn stop(app: &AppHandle) {
    let chat = app.state::<Chat>();
    let active = chat.active.lock().unwrap();
    if let Some(a) = active.as_ref() {
        a.cancelled.store(true, Ordering::SeqCst);
        // notify_one keeps a permit if the task isn't waiting yet.
        a.cancel.notify_one();
        log::line(format!("chat #{} stop requested", a.id));
    }
}

/// New conversation. A turn still running is stopped and its result dropped;
/// the old conversation is summarised into memory first.
pub fn reset(app: &AppHandle) {
    stop(app);
    let chat = app.state::<Chat>();
    chat.epoch.fetch_add(1, Ordering::Relaxed);
    let old = std::mem::take(&mut *chat.history.lock().unwrap());
    memory::save_chat(&[]);
    summarize(app, old);
}

// ── Models, test ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    /// Shown first in the list (Gemini Flash models).
    pub featured: bool,
}

pub async fn list_models(app: &AppHandle) -> Result<Vec<ModelInfo>, String> {
    gemini::list_models(&provider(app, false)?).await
}

/// Checks that the key works and the model is there, without chatting.
pub async fn test(app: &AppHandle) -> Result<String, String> {
    gemini::test(&provider(app, true)?).await
}

#[cfg(test)]
mod tests {
    use super::{validate_base, weekday};

    #[test]
    fn base_urls_need_https_unless_local() {
        assert_eq!(validate_base("http://127.0.0.1:8080/v1beta/").unwrap(), "http://127.0.0.1:8080/v1beta");
        assert!(validate_base("http://192.168.1.20:8000").is_ok());
        assert!(validate_base("https://generativelanguage.googleapis.com/v1beta").is_ok());
        assert!(validate_base("http://example.com").is_err());
        assert!(validate_base("ftp://x").is_err());
        assert!(validate_base("https://").is_err());
    }

    #[test]
    fn weekdays() {
        assert_eq!(weekday(2026, 10, 16), "Jumat");
        assert_eq!(weekday(2026, 1, 1), "Kamis");
    }
}
