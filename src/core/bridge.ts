// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the widget can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[miu-lite] ${cmd} failed`, err);
    return null;
  }
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("Hanya tersedia di aplikasi desktop.");
  return invoke<T>(cmd, args);
}

export interface ScreenInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface BootInfo {
  settings: Settings;
  /** Logical work area of the monitor the widget lives on. */
  screen: ScreenInfo;
  version: string;
  /** Where dropped files go: %USERPROFILE%\Miu, or the folder picked in the settings. */
  dropRoot: string;
}

export interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  /** Listed first (Gemini Flash models). */
  featured: boolean;
}

export interface ChatEvent {
  requestId: number;
  /** "tool": the model is using a memory tool; `text` says which, for the user. */
  kind: "delta" | "tool" | "search" | "suggestions" | "done" | "stopped" | "error";
  text: string;
  code: "key" | "model" | "ratelimit" | "network" | "blocked" | "server" | "other" | null;
}

export interface PlanItem {
  source: string;
  name: string;
  size: number;
  folder: string;
  destName: string;
  destPath: string;
  renamed: boolean;
  error: string | null;
}

export interface FilePlan {
  root: string;
  rootExists: boolean;
  items: PlanItem[];
}

export interface CopyResult {
  source: string;
  name: string;
  folder: string;
  destPath: string | null;
  size: number;
  renamed: boolean;
  ok: boolean;
  error: string | null;
}

export const GEMINI_KEY = "gemini-api-key";

/** One message of the saved conversation (chat.json). */
export interface Turn {
  user: boolean;
  text: string;
  suggestions?: string;
}

/** One fact Miu keeps about the user (memory.json). */
export interface Fact {
  id: number;
  text: string;
  /** profil, pekerjaan, proyek, preferensi, orang, kebiasaan, rencana, lainnya. */
  kind: string;
  /** yyyy-MM-dd. */
  date: string;
  /** "chat" (Gemini saved it) or "ringkasan" (a summary). */
  source: string;
}
export const Bridge = {
  boot: () => call<BootInfo>("boot"),
  saveSettings: (settings: Settings) => IS_TAURI ? callOrThrow<void>("save_settings", { settings }) : Promise.resolve(),

  /** Shapes that take the mouse; everything else in the window is click-through. */
  setHitRects: (rects: HitRect[]) => call<void>("set_hit_rects", { rects }),
  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),
  reposition: () => call<void>("reposition"),
  /** Window top-left, logical screen px (while the character is dragged). */
  moveWidget: (x: number, y: number) => call<void>("move_widget", { x, y }),
  /** Grows or shrinks the window (logical px) around a resized chat panel; returns the size used. */
  resizeWidget: (w: number, h: number) => call<[number, number]>("resize_widget", { w, h }),
  /** Work area of the widget's display. */
  screenInfo: () => call<ScreenInfo>("screen_info"),
  hideWidget: () => call<void>("hide_widget"),
  openUrl: (url: string) => call<void>("open_url", { url }),
  openSettingsWindow: () => call<void>("open_settings_window"),
  quit: () => call<void>("quit_app"),
  /** Writes to %LOCALAPPDATA%\Miu\companion.log. */
  log: (message: string) => call<void>("log_line", { message }),
  /** Spotify playing right now; changes also arrive as `music-playing` events. */
  musicPlaying: () => call<boolean>("music_playing"),

  // ── Gemini ────────────────────────────────────────────────────────────────
  /** Starts a streaming turn; returns its request ID. Answers arrive as `chat` events. */
  chatSend: (text: string) => callOrThrow<number>("chat_send", { text }),
  chatStop: () => call<void>("chat_stop"),
  chatReset: () => call<void>("chat_reset"),
  /** The conversation so far, restored from chat.json at launch. */
  chatHistory: () => call<Turn[]>("chat_history"),
  /** Models the saved key can use. */
  llmModels: () => callOrThrow<ModelInfo[]>("llm_models"),
  llmTest: () => callOrThrow<string>("llm_test"),
  /** Normalised base URL, or an error saying why it is refused. */
  llmCheckUrl: (url: string) => callOrThrow<string>("llm_check_url", { url }),

  // ── Memory ────────────────────────────────────────────────────────────────
  memoryList: () => call<Fact[]>("memory_list"),
  memoryForget: (id: number) => callOrThrow<void>("memory_forget", { id }),
  memoryClear: () => callOrThrow<void>("memory_clear"),

  // ── Files ─────────────────────────────────────────────────────────────────
  filesPlan: (paths: string[]) => callOrThrow<FilePlan>("files_plan", { paths }),
  filesCopy: (paths: string[]) => callOrThrow<CopyResult[]>("files_copy", { paths }),
  filesReveal: (path: string) => callOrThrow<void>("files_reveal", { path }),
  /** Where dropped files go right now. */
  filesRoot: () => call<string>("files_root"),
  /** Windows folder picker; null when cancelled. Save the result as `dropRoot`. */
  pickDropFolder: () => call<string | null>("pick_drop_folder"),

  // ── Secrets ───────────────────────────────────────────────────────────────
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),
};

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
