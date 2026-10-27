// Miu's memory, kept on this laptop — no server. Two files in the data folder
// (portable: MiuLite-data next to the exe):
//
//   - memory.json: facts about the user. Gemini adds and removes them with two
//     tools while chatting, the settings window lists and removes them, and a
//     summary of finished conversations adds the ones worth keeping (llm.rs).
//     They go into the system prompt of every turn.
//   - chat.json: the current conversation, so it is still there after a
//     restart or a shutdown.
//
// Every change is written at once, through a temp file and a rename, so a
// shutdown or a power cut never leaves half a file behind.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::llm::Turn;
use crate::{log, platform};

pub const SAVE_TOOL: &str = "ingat_tentang_pengguna";
pub const FORGET_TOOL: &str = "lupakan_ingatan";
pub const KINDS: &[&str] = &["profil", "pekerjaan", "proyek", "preferensi", "orang", "kebiasaan", "rencana", "lainnya"];
const MAX_FACTS: usize = 200;
const MAX_FACT_CHARS: usize = 300;
/// Facts one summary may add.
const MAX_FROM_SUMMARY: usize = 8;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: u32,
    pub text: String,
    /// One of KINDS.
    pub kind: String,
    /// yyyy-MM-dd, from the PC clock.
    pub date: String,
    /// "chat" (Gemini's tool), "ringkasan" (a summary).
    pub source: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    next_id: u32,
    facts: Vec<Fact>,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn file(name: &str) -> PathBuf {
    platform::config_dir().join(name)
}

/// Writes the whole file next to its target, flushes it to disk, then swaps it in.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        platform::ensure_private_dir(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// A file that does not parse is set aside (never overwritten), and the app
/// starts from empty.
fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    let Ok(bytes) = std::fs::read(path) else { return T::default() };
    match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(err) => {
            let bad = path.with_extension("json.bad");
            let _ = std::fs::rename(path, &bad);
            log::line(format!("memory: {} unreadable ({err}), kept as {}", path.display(), bad.display()));
            T::default()
        }
    }
}

fn with_store<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    let mut guard = STORE.lock().unwrap();
    let store = guard.get_or_insert_with(|| read_json(&file("memory.json")));
    f(store)
}

fn persist(store: &Store) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    write_atomic(&file("memory.json"), &bytes).map_err(|e| {
        log::line(format!("memory: could not save: {e}"));
        format!("Gagal menyimpan ingatan: {e}")
    })
}

fn today() -> String {
    let t = platform::local_time();
    format!("{:04}-{:02}-{:02}", t.year, t.month, t.day)
}

fn same_text(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches('.').to_lowercase();
    norm(a) == norm(b)
}

// ── Facts ─────────────────────────────────────────────────────────────────────

pub fn list() -> Vec<Fact> {
    with_store(|s| s.facts.clone())
}

/// Saves one fact. The same text twice keeps the first one.
pub fn add(text: &str, kind: &str, source: &str) -> Result<Fact, String> {
    let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err("Fakta kosong.".into());
    }
    if text.chars().count() > MAX_FACT_CHARS {
        return Err(format!("Fakta terlalu panjang (maksimal {MAX_FACT_CHARS} karakter)."));
    }
    let kind = if KINDS.contains(&kind) { kind } else { "lainnya" };
    with_store(|s| {
        if let Some(existing) = s.facts.iter().find(|f| same_text(&f.text, &text)) {
            return Ok(existing.clone());
        }
        if s.facts.len() >= MAX_FACTS {
            return Err(format!("Ingatan penuh ({MAX_FACTS} fakta). Hapus beberapa di Pengaturan → Ingatan."));
        }
        s.next_id = s.next_id.max(s.facts.iter().map(|f| f.id).max().unwrap_or(0)) + 1;
        let fact = Fact { id: s.next_id, text, kind: kind.into(), date: today(), source: source.into() };
        s.facts.push(fact.clone());
        if let Err(e) = persist(s) {
            s.facts.pop();
            return Err(e);
        }
        Ok(fact)
    })
}

pub fn forget(id: u32) -> Result<Fact, String> {
    with_store(|s| {
        let pos = s.facts.iter().position(|f| f.id == id).ok_or(format!("Tidak ada fakta #{id}."))?;
        let fact = s.facts.remove(pos);
        if let Err(e) = persist(s) {
            s.facts.insert(pos, fact);
            return Err(e);
        }
        Ok(fact)
    })
}

pub fn clear() -> Result<(), String> {
    with_store(|s| {
        let old = std::mem::take(&mut s.facts);
        if let Err(e) = persist(s) {
            s.facts = old;
            return Err(e);
        }
        Ok(())
    })
}

/// What goes into the system prompt: the facts and how to use the tools.
pub fn context(auto_summary: bool) -> String {
    let facts = list();
    let mut out = String::from(
        " Kamu punya ingatan jangka panjang tentang pengguna yang tersimpan di laptop pengguna, di luar percakapan ini.",
    );
    if facts.is_empty() {
        out.push_str(" Saat ini belum ada yang tersimpan.");
    } else {
        out.push_str(" Yang kamu ingat tentang pengguna:");
        for f in &facts {
            out.push_str(&format!("\n#{} [{}] {}", f.id, f.kind, f.text));
        }
    }
    out.push_str(
        "\nPakai ingatan ini dengan wajar seperti teman yang sudah kenal pengguna: sebut hanya yang relevan, \
jangan dibacakan semuanya. Kalau ingatan bertentangan dengan yang dikatakan pengguna sekarang, percayai \
pengguna. Nomor # hanya untuk alat ingatan, jangan disebut ke pengguna.",
    );
    if auto_summary {
        out.push_str(
            " Percakapan juga diringkas otomatis menjadi ingatan, jadi kamu tidak perlu menyimpan semuanya sendiri.",
        );
    }
    out.push_str(&format!(
        " Panggil {SAVE_TOOL} kalau pengguna memintamu mengingat sesuatu, atau menyebut fakta penting tentang \
dirinya yang jelas akan berguna lagi (misalnya alergi, nama orang dekat, tenggat penting). Jangan pernah \
menyimpan password, API key, token, PIN, atau data pribadi orang lain. Kalau pengguna minta sesuatu \
dilupakan atau membetulkan ingatan yang salah, panggil {FORGET_TOOL} dengan nomor fakta itu, lalu simpan \
versi yang benar kalau ada. Setelah menyimpan atau menghapus, cukup konfirmasi singkat."
    ));
    out
}

// ── Chat tools ────────────────────────────────────────────────────────────────

/// The two memory tools, as Gemini function declarations.
pub fn tool_declarations() -> Vec<Value> {
    vec![
        json!({
            "name": SAVE_TOOL,
            "description": "Menyimpan satu fakta tentang pengguna ke ingatan jangka panjang Miu di laptop ini, \
supaya masih diingat di percakapan berikutnya. Satu fakta per panggilan, ditulis sebagai kalimat singkat \
orang ketiga, misalnya \"Pengguna alergi udang.\"",
            "parameters": {
                "type": "object",
                "properties": {
                    "fakta": { "type": "string", "description": "Fakta singkat tentang pengguna, satu kalimat, maksimal 300 karakter." },
                    "jenis": { "type": "string", "enum": KINDS, "description": "Jenis fakta." }
                },
                "required": ["fakta", "jenis"]
            }
        }),
        json!({
            "name": FORGET_TOOL,
            "description": "Menghapus satu fakta dari ingatan jangka panjang Miu berdasarkan nomornya (#) di daftar yang kamu ingat.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "Nomor fakta tanpa tanda #." }
                },
                "required": ["id"]
            }
        }),
    ]
}

pub fn status_text(name: &str) -> &'static str {
    match name {
        SAVE_TOOL => "Menyimpan ke ingatan…",
        FORGET_TOOL => "Menghapus dari ingatan…",
        _ => "Menjalankan alat…",
    }
}

/// Runs one call. Always a JSON object: `{"error": …}` on failure, so the
/// model can say what went wrong instead of guessing.
pub fn run_tool(name: &str, args: &Value) -> Value {
    let result = match name {
        SAVE_TOOL => {
            let text = args.get("fakta").and_then(Value::as_str).unwrap_or("");
            let kind = args.get("jenis").and_then(Value::as_str).unwrap_or("lainnya");
            add(text, kind, "chat").map(|f| json!({ "tersimpan": true, "id": f.id, "fakta": f.text }))
        }
        FORGET_TOOL => match args.get("id").and_then(|v| v.as_u64().or_else(|| v.as_str()?.trim_start_matches('#').parse().ok())) {
            Some(id) => forget(id as u32).map(|f| json!({ "dihapus": true, "fakta": f.text })),
            None => Err("Nomor fakta (id) tidak ada.".into()),
        },
        _ => Err(format!("Alat {name} tidak dikenal.")),
    };
    result.unwrap_or_else(|e| json!({ "error": e }))
}

// ── Summary ───────────────────────────────────────────────────────────────────

/// System prompt and prompt asking Gemini for the facts worth keeping from a
/// finished stretch of conversation, as a JSON array.
pub fn summary_request(turns: &[Turn]) -> (String, String) {
    let known: Vec<String> = list().iter().map(|f| format!("- {}", f.text)).collect();
    let system = format!(
        "Kamu membantu Miu, asisten desktop, mengingat pengguna. Dari percakapan yang diberikan, ambil \
paling banyak {MAX_FROM_SUMMARY} fakta baru yang penting dan tahan lama tentang pengguna: profil, pekerjaan, \
proyek, preferensi, orang dekat, kebiasaan, rencana atau tenggat. Abaikan basa-basi, pertanyaan umum, dan \
hal yang hanya berlaku saat itu. Jangan ulangi fakta yang sudah diketahui. Jangan pernah mengambil password, \
API key, token, PIN, atau data pribadi orang lain. Tulis tiap fakta sebagai satu kalimat singkat orang ketiga, \
misalnya \"Pengguna alergi udang.\" Jawab hanya dengan array JSON berisi objek {{\"fakta\": string, \
\"jenis\": salah satu dari {}}}, atau [] kalau tidak ada yang layak diingat.",
        KINDS.join(", ")
    );
    let mut prompt = String::from("Fakta yang sudah diketahui:\n");
    prompt.push_str(if known.is_empty() { "(belum ada)" } else { "" });
    prompt.push_str(&known.join("\n"));
    prompt.push_str("\n\nPercakapan:\n");
    for t in turns {
        let who = if t.user { "Pengguna" } else { "Miu" };
        let text: String = t.text.chars().take(2000).collect();
        prompt.push_str(&format!("{who}: {text}\n"));
    }
    (system, prompt)
}

/// Saves the facts of a summary answer; returns how many were new.
pub fn apply_summary(answer: &str) -> usize {
    // Tolerate a ```json fence around the array.
    let start = answer.find('[');
    let end = answer.rfind(']');
    let Some(raw) = start.zip(end).filter(|(a, b)| a < b).map(|(a, b)| &answer[a..=b]) else { return 0 };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else { return 0 };
    let before = list().len();
    for item in items.iter().take(MAX_FROM_SUMMARY) {
        let text = item.get("fakta").and_then(Value::as_str).unwrap_or("");
        let kind = item.get("jenis").and_then(Value::as_str).unwrap_or("lainnya");
        if let Err(e) = add(text, kind, "ringkasan") {
            log::line(format!("memory: summary fact skipped: {e}"));
        }
    }
    list().len().saturating_sub(before)
}

// ── Conversation ──────────────────────────────────────────────────────────────

pub fn load_chat() -> Vec<Turn> {
    read_json(&file("chat.json"))
}

/// Saves the conversation; an empty one removes the file.
pub fn save_chat(turns: &[Turn]) {
    let path = file("chat.json");
    if turns.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    let result = serde_json::to_vec(turns)
        .map_err(|e| e.to_string())
        .and_then(|bytes| write_atomic(&path, &bytes).map_err(|e| e.to_string()));
    if let Err(e) = result {
        log::line(format!("memory: could not save chat: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_facts_match_loosely() {
        assert!(same_text("Pengguna alergi udang.", " pengguna ALERGI udang "));
        assert!(!same_text("Pengguna alergi udang.", "Pengguna alergi kacang."));
    }

    #[test]
    fn summary_answers_need_an_array() {
        // No array: nothing parsed, nothing written.
        assert_eq!(apply_summary("tidak ada"), 0);
        assert_eq!(apply_summary("[]"), 0);
    }
}
