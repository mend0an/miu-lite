// Preferences, stored as plain JSON in settings.json under platform::config_dir()
// (next to the exe in portable mode). No secret ever lands here — the Gemini
// API key lives in the Credential Manager (secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderProfile {
    pub model: String,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub provider: String,
    pub provider_profiles: BTreeMap<String, ProviderProfile>,
    pub web_search: bool,
    /// Active provider's API base URL; empty uses that provider's default.
    pub llm_base_url: String,
    /// Active provider model ID. Empty until the user picks one.
    pub model: String,
    /// Character size multiplier, 0.8–1.4.
    pub character_scale: f64,
    /// Pauses the character animation.
    pub reduced_motion: bool,
    /// The character dances while Spotify is playing (media.rs).
    pub dance_to_music: bool,
    /// Miu keeps facts about the user (memory.json) and gets the tools to
    /// save and forget them.
    pub memory_enabled: bool,
    /// Finished conversations are summarised into facts (uses the selected model).
    pub auto_summary: bool,
    /// The conversation is saved (chat.json) and comes back after a restart.
    pub keep_chat: bool,
    /// Where dropped files are copied (absolute path). Empty = the default,
    /// a "Miu Lite" folder next to the exe (files.rs).
    pub drop_root: String,
    /// Where the user dragged the character: its canvas top-left in logical
    /// screen pixels. None = the default spot, bottom-right of the work area.
    pub widget_x: Option<f64>,
    pub widget_y: Option<f64>,
    /// Chat panel size the user dragged it to, logical px. None = the default
    /// (348 wide, as tall as the content allows).
    pub chat_width: Option<f64>,
    pub chat_height: Option<f64>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            screen: "primary".into(),
            autostart: false,
            provider: "gemini".into(),
            provider_profiles: BTreeMap::new(),
            web_search: true,
            llm_base_url: String::new(),
            model: String::new(),
            character_scale: 1.0,
            reduced_motion: false,
            dance_to_music: true,
            memory_enabled: true,
            auto_summary: true,
            keep_chat: true,
            drop_root: String::new(),
            widget_x: None,
            widget_y: None,
            chat_width: None,
            chat_height: None,
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_profiles_and_legacy_gemini_settings_survive() {
        let old:Settings = serde_json::from_str(r#"{"model":"existing-gemini","llmBaseUrl":"https://proxy.example/v1beta"}"#).unwrap();
        assert_eq!(old.provider,"gemini");
        assert!(old.web_search);
        assert_eq!(old.model,"existing-gemini");
        assert_eq!(old.llm_base_url,"https://proxy.example/v1beta");
        let mut current=old;
        current.provider_profiles.insert("ollama".into(),ProviderProfile{model:"local:small".into(),base_url:"http://127.0.0.1:11434".into()});
        let restored:Settings=serde_json::from_str(&serde_json::to_string(&current).unwrap()).unwrap();
        assert_eq!(restored.provider_profiles["ollama"].model,"local:small");
    }


    #[test]
    fn partial_settings_keep_defaults_and_round_trip_preferences() {
        let settings: Settings = serde_json::from_str(r#"{"model":"saved-model","keepChat":false,"characterScale":1.15}"#).unwrap();
        assert_eq!(settings.model, "saved-model");
        assert!(!settings.keep_chat);
        assert!(settings.dance_to_music);
        let json = serde_json::to_string(&settings).unwrap();
        let restored: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.character_scale, 1.15);
        assert!(!json.contains("character\":"));
        assert!(!json.contains("outfit"));
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
