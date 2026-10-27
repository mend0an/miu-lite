// Google Gemini on its native API (generativelanguage.googleapis.com, or the
// base URL set in the settings). Used through llm.rs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::Notify;

use crate::llm::{self, emit, failure, Failure, ModelInfo, Outcome, Provider, Turn, CONNECT_TIMEOUT, IDLE_TIMEOUT};

/// Accepts "gemini-3.6-flash" or "models/gemini-3.6-flash"; refuses anything
/// that is not a plain identifier, since it ends up in the request path.
pub fn normalize_model(raw: &str) -> Result<String, String> {
    let id = raw.trim().trim_start_matches("models/").to_string();
    let valid = !id.is_empty()
        && id.len() <= 100
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if valid {
        Ok(id)
    } else {
        Err("ID model tidak valid. Contoh yang benar: gemini-3.6-flash".into())
    }
}

/// Turns an HTTP error from the Gemini API into a message the user can act on.
fn describe_http(status: reqwest::StatusCode, body: &str, model: &str) -> Failure {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let err = v.get("error");
    let message = err.and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("").to_string();
    let details = err.and_then(|e| e.get("details")).and_then(Value::as_array);
    let reason = details
        .and_then(|d| d.iter().find_map(|x| x.get("reason").and_then(Value::as_str)))
        .unwrap_or("");
    let retry = details
        .and_then(|d| d.iter().find_map(|x| x.get("retryDelay").and_then(Value::as_str)))
        .map(|s| format!(" Coba lagi dalam {s}."))
        .unwrap_or_else(|| " Coba lagi sebentar lagi.".into());

    match status.as_u16() {
        400 if reason == "API_KEY_INVALID" || message.contains("API key") => {
            failure("key", "API key Gemini ditolak. Periksa key di Pengaturan.")
        }
        401 | 403 => failure("key", format!("Akses ke Gemini ditolak ({status}). {message}")),
        404 => failure(
            "model",
            format!("Model \"{model}\" tidak ditemukan atau tidak bisa dipakai dengan key ini. Pilih model lain di Pengaturan."),
        ),
        429 => failure("ratelimit", format!("Batas kuota atau rate Gemini tercapai.{retry}")),
        500..=599 => failure("server", format!("Layanan Gemini sedang bermasalah ({status}). Coba lagi nanti.")),
        _ => failure("other", format!("Gemini API {status}: {message}")),
    }
}

fn contents(turns: &[Turn]) -> Vec<Value> {
    turns
        .iter()
        .map(|t| json!({ "role": if t.user { "user" } else { "model" }, "parts": [{ "text": t.text }] }))
        .collect()
}

/// Every model this key can call with generateContent, Flash models first.
pub async fn list_models(p: &Provider) -> Result<Vec<ModelInfo>, String> {
    let http = llm::client()?;
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    for _ in 0..5 {
        let mut req = http
            .get(format!("{}/models", p.base))
            .header("x-goog-api-key", &p.key)
            .query(&[("pageSize", "1000")]);
        if let Some(token) = &page {
            req = req.query(&[("pageToken", token.as_str())]);
        }
        let response = tokio::time::timeout(CONNECT_TIMEOUT, req.send())
            .await
            .map_err(|_| "Waktu habis saat menghubungi Gemini.".to_string())?
            .map_err(|e| format!("Gagal terhubung ke Gemini: {}", e.without_url()))?;
        let status = response.status();
        let body = response.text().await.map_err(|e| e.without_url().to_string())?;
        if !status.is_success() {
            return Err(describe_http(status, &body, "").message);
        }
        let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        for m in v.get("models").and_then(Value::as_array).into_iter().flatten() {
            let can_generate = m
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .map(|a| a.iter().any(|x| x.as_str() == Some("generateContent")))
                .unwrap_or(false);
            let Some(name) = m.get("name").and_then(Value::as_str) else { continue };
            if !can_generate {
                continue;
            }
            let id = name.trim_start_matches("models/").to_string();
            let display_name = m.get("displayName").and_then(Value::as_str).unwrap_or(&id).to_string();
            let featured = id.contains("flash");
            out.push(ModelInfo { id, display_name, featured });
        }
        page = v.get("nextPageToken").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string);
        if page.is_none() {
            break;
        }
    }
    out.sort_by(|a, b| b.featured.cmp(&a.featured).then_with(|| b.id.cmp(&a.id)));
    Ok(out)
}

/// Checks that the key works and the model exists, without spending tokens.
pub async fn test(p: &Provider) -> Result<String, String> {
    let response = tokio::time::timeout(
        CONNECT_TIMEOUT,
        llm::client()?
            .get(format!("{}/models/{}", p.base, p.model))
            .header("x-goog-api-key", &p.key)
            .send(),
    )
    .await
    .map_err(|_| "Waktu habis saat menghubungi Gemini.".to_string())?
    .map_err(|e| format!("Gagal terhubung ke Gemini: {}", e.without_url()))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.without_url().to_string())?;
    if !status.is_success() {
        return Err(describe_http(status, &body, &p.model).message);
    }
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let name = v.get("displayName").and_then(Value::as_str).unwrap_or(&p.model);
    Ok(format!("Terhubung ke Gemini. Model: {name} ({})", p.model))
}

/// A short, non-streaming JSON answer for background work (the memory
/// summary). Gives up after `limit`.
pub async fn one_shot(p: &Provider, system: &str, prompt: &str, limit: Duration) -> Result<String, String> {
    let body = json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        // Room for models that think before answering; the answer itself is short.
        "generationConfig": { "maxOutputTokens": 2048, "temperature": 0.2, "responseMimeType": "application/json" },
    });
    let request = llm::client()?
        .post(format!("{}/models/{}:generateContent", p.base, p.model))
        .header("x-goog-api-key", &p.key)
        .json(&body)
        .send();
    let response = tokio::time::timeout(limit, request)
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| e.without_url().to_string())?;
    let status = response.status();
    let text = tokio::time::timeout(limit, response.text())
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|e| e.without_url().to_string())?;
    if !status.is_success() {
        return Err(describe_http(status, &text, &p.model).message);
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(answer_text(&v))
}

/// Text of the first candidate, thought summaries left out.
fn answer_text(v: &Value) -> String {
    v.get("candidates")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p.get("thought").and_then(Value::as_bool) != Some(true))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// One streaming turn. Text goes to the page as it comes. With `tools`
/// (function declarations), the model may call them first: the results go
/// back and it is asked again, at most MAX_TOOL_ROUNDS times.
#[allow(clippy::too_many_arguments)]
pub async fn stream(
    app: &AppHandle,
    id: u64,
    p: &Provider,
    system: &str,
    tools: &[Value],
    turns: &[Turn],
    cancel: &Notify,
    cancelled: &AtomicBool,
) -> Outcome {
    let http = match llm::client() {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(failure("other", e)),
    };
    let mut contents = contents(turns);
    let mut text = String::new();

    for round in 0..=llm::MAX_TOOL_ROUNDS {
        let mut body = json!({
            "systemInstruction": { "parts": [{ "text": system }] },
            "contents": contents,
        });
        if !tools.is_empty() {
            body["tools"] = json!([{ "functionDeclarations": tools }]);
            // Out of rounds: the tools stay declared (the history has calls)
            // but the model has to answer now.
            if round == llm::MAX_TOOL_ROUNDS {
                body["toolConfig"] = json!({ "functionCallingConfig": { "mode": "NONE" } });
            }
        }
        let r = match stream_request(app, id, &http, p, &body, &mut text, cancel, cancelled).await {
            Ok(r) => r,
            Err(outcome) => return outcome,
        };
        if r.calls.is_empty() {
            return finish(text, r.finish.as_deref());
        }

        // Send the model's turn back exactly as it came (thought signatures
        // included), then one response per call.
        contents.push(json!({ "role": "model", "parts": r.parts }));
        let mut responses = Vec::new();
        for call in &r.calls {
            if cancelled.load(Ordering::SeqCst) {
                return Outcome::Stopped { text };
            }
            let name = call.get("name").and_then(Value::as_str).unwrap_or("");
            let args = call.get("args").cloned().unwrap_or(Value::Null);
            let result = llm::run_tool(app, id, name, &args);
            let mut response = json!({ "name": name, "response": result });
            if let Some(call_id) = call.get("id") {
                response["id"] = call_id.clone();
            }
            responses.push(json!({ "functionResponse": response }));
        }
        contents.push(json!({ "role": "user", "parts": responses }));
        if !text.is_empty() && !text.ends_with('\n') {
            text.push_str("\n\n");
        }
    }
    // The last round forbids calls, so it always returns above.
    Outcome::Failed(failure("other", "Gemini terus memanggil alat tanpa menjawab."))
}

fn finish(text: String, reason: Option<&str>) -> Outcome {
    let text = text.trim_end().to_string();
    match reason {
        Some("SAFETY" | "PROHIBITED_CONTENT" | "BLOCKLIST" | "SPII" | "RECITATION") if text.is_empty() => {
            Outcome::Failed(failure("blocked", "Gemini menolak menjawab permintaan ini."))
        }
        Some("MAX_TOKENS") => Outcome::Done { text, note: Some("Jawaban terpotong karena batas panjang.".into()) },
        _ if text.is_empty() => Outcome::Failed(failure("other", "Gemini tidak mengirim jawaban.")),
        _ => Outcome::Done { text, note: None },
    }
}

/// What one streamed request produced besides the text.
#[derive(Default)]
struct Round {
    /// Every part of the model's content, to send back with the call results.
    parts: Vec<Value>,
    /// `functionCall` objects, in order.
    calls: Vec<Value>,
    finish: Option<String>,
}

/// One streaming request. Text goes into `text` as it comes; Err carries the
/// outcome that ends the turn (stopped or failed).
#[allow(clippy::too_many_arguments)]
async fn stream_request(
    app: &AppHandle,
    id: u64,
    http: &reqwest::Client,
    p: &Provider,
    body: &Value,
    text: &mut String,
    cancel: &Notify,
    cancelled: &AtomicBool,
) -> Result<Round, Outcome> {
    let request = http
        .post(format!("{}/models/{}:streamGenerateContent", p.base, p.model))
        .query(&[("alt", "sse")])
        .header("x-goog-api-key", &p.key)
        .json(body)
        .send();

    let mut response = tokio::select! {
        r = tokio::time::timeout(CONNECT_TIMEOUT, request) => match r {
            Err(_) => return Err(Outcome::Failed(failure("network", "Waktu habis menunggu Gemini. Periksa koneksi internet."))),
            Ok(Err(e)) => return Err(Outcome::Failed(failure("network", format!("Gagal terhubung ke Gemini: {}", e.without_url())))),
            Ok(Ok(r)) => r,
        },
        _ = cancel.notified() => return Err(Outcome::Stopped { text: text.clone() }),
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(Outcome::Failed(describe_http(status, &body, &p.model)));
    }

    let mut buf: Vec<u8> = Vec::new();
    let mut round = Round::default();

    loop {
        let next = tokio::select! {
            c = tokio::time::timeout(IDLE_TIMEOUT, response.chunk()) => c,
            _ = cancel.notified() => return Err(Outcome::Stopped { text: text.clone() }),
        };
        let chunk = match next {
            Err(_) => return Err(Outcome::Failed(failure("network", "Gemini berhenti mengirim jawaban (waktu habis)."))),
            Ok(Err(e)) => return Err(Outcome::Failed(failure("network", format!("Koneksi terputus: {}", e.without_url())))),
            Ok(Ok(None)) => break,
            Ok(Ok(Some(bytes))) => bytes,
        };
        for data in llm::sse_take(&mut buf, &chunk) {
            if cancelled.load(Ordering::SeqCst) {
                return Err(Outcome::Stopped { text: text.clone() });
            }
            handle_event(app, id, &data, text, &mut round).map_err(Outcome::Failed)?;
        }
    }
    let rest = llm::sse_data(&buf);
    if !rest.is_empty() && !cancelled.load(Ordering::SeqCst) {
        handle_event(app, id, &rest, text, &mut round).map_err(Outcome::Failed)?;
    }
    if cancelled.load(Ordering::SeqCst) {
        return Err(Outcome::Stopped { text: text.clone() });
    }
    Ok(round)
}

/// One SSE event's data: a GenerateContentResponse.
fn handle_event(app: &AppHandle, id: u64, data: &str, text: &mut String, round: &mut Round) -> Result<(), Failure> {
    let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(()) };
    if let Some(err) = v.get("error") {
        let message = err.get("message").and_then(Value::as_str).unwrap_or("kesalahan tidak dikenal");
        return Err(failure("server", format!("Gemini: {message}")));
    }
    if let Some(block) = v.get("promptFeedback").and_then(|p| p.get("blockReason")).and_then(Value::as_str) {
        return Err(failure("blocked", format!("Gemini menolak permintaan ini ({block}).")));
    }
    let candidate = v.get("candidates").and_then(Value::as_array).and_then(|c| c.first());
    let parts = candidate.and_then(|c| c.get("content")).and_then(|c| c.get("parts")).and_then(Value::as_array);
    for part in parts.into_iter().flatten() {
        round.parts.push(part.clone());
        if let Some(call) = part.get("functionCall") {
            round.calls.push(call.clone());
            continue;
        }
        // Thought summaries are not part of the answer.
        if part.get("thought").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if let Some(delta) = part.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            text.push_str(delta);
            emit(app, id, "delta", delta.to_string(), None);
        }
    }
    if let Some(r) = candidate.and_then(|c| c.get("finishReason")).and_then(Value::as_str) {
        round.finish = Some(r.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_model;

    #[test]
    fn model_ids_are_plain_identifiers() {
        assert_eq!(normalize_model("gemini-3.6-flash").unwrap(), "gemini-3.6-flash");
        assert_eq!(normalize_model(" models/gemini-3.6-flash ").unwrap(), "gemini-3.6-flash");
        assert!(normalize_model("").is_err());
        assert!(normalize_model("gemini/../../x").is_err());
        assert!(normalize_model("gemini-flash?key=1").is_err());
        assert!(normalize_model("gemini flash").is_err());
    }
}
