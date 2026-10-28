// Preferences shared by the widget and the settings window. Mirrors
// src-tauri/src/settings.rs; keys never appear here.

export const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type ProviderId = "gemini" | "openai" | "claude" | "ollama";
export const PROVIDERS = {
  gemini: { label: "Google Gemini", key: "gemini-api-key", base: GEMINI_DEFAULT_BASE },
  openai: { label: "OpenAI / GPT", key: "openai-api-key", base: "https://api.openai.com/v1" },
  claude: { label: "Anthropic / Claude", key: "claude-api-key", base: "https://api.anthropic.com/v1" },
  ollama: { label: "Ollama (lokal)", key: "ollama-api-key", base: "http://127.0.0.1:11434" },
} as const;

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  screen: "primary" | "cursor";
  autostart: boolean;
  provider: ProviderId;
  providerProfiles: Partial<Record<ProviderId, { model: string; baseUrl: string }>>;
  webSearch: boolean;
  /** Active provider API base URL; empty uses its default. */
  llmBaseUrl: string;
  /** Active provider model ID. */
  model: string;
  /** Character size multiplier, 0.8–1.4. */
  characterScale: number;
  reducedMotion: boolean;
  /** The character dances while Spotify is playing. */
  danceToMusic: boolean;
  /** Miu keeps facts about the user and may save or forget them while chatting. */
  memoryEnabled: boolean;
  /** Finished conversations are summarised into facts (one request to the selected model each). */
  autoSummary: boolean;
  /** The conversation is saved and comes back after a restart. */
  keepChat: boolean;
  /** Where dropped files are copied; empty = the "Files" folder next to the exe. */
  dropRoot: string;
  /** Dragged position of the character (canvas top-left, logical screen px). */
  widgetX: number | null;
  widgetY: number | null;
  /** Chat panel size the user dragged it to (logical px); null = default. */
  chatWidth: number | null;
  chatHeight: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  screen: "primary",
  autostart: false,
  provider: "gemini",
  providerProfiles: {},
  webSearch: true,
  llmBaseUrl: "",
  model: "",
  characterScale: 1,
  reducedMotion: false,
  danceToMusic: true,
  memoryEnabled: true,
  autoSummary: true,
  keepChat: true,
  dropRoot: "",
  widgetX: null,
  widgetY: null,
  chatWidth: null,
  chatHeight: null,
};
