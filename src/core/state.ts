// Preferences shared by the widget and the settings window. Mirrors
// src-tauri/src/settings.rs; keys never appear here.

export const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  screen: "primary" | "cursor";
  autostart: boolean;
  /** Gemini API base URL; empty = Google's default endpoint. */
  llmBaseUrl: string;
  /** Gemini model ID, e.g. "gemini-3.6-flash". */
  model: string;
  /** Character size multiplier, 0.8–1.4. */
  characterScale: number;
  reducedMotion: boolean;
  /** The character dances while Spotify is playing. */
  danceToMusic: boolean;
  /** Miu keeps facts about the user and may save or forget them while chatting. */
  memoryEnabled: boolean;
  /** Finished conversations are summarised into facts (one Gemini call each). */
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
