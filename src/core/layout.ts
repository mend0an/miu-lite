// Animation states and dimensions shared by Miu and the widget.

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

/** Status text shown next to the character, readable with animation off (FR04). */
export const STATE_LABEL: Record<BotStateName, string> = {
  idle: "",
  working: "Sedang bekerja…",
  thinking: "Berpikir…",
  searching: "Mencari…",
  approval: "Menunggu izinmu",
  question: "Menunggu jawabanmu",
  error: "Ada masalah",
  finished: "Selesai",
  ratelimit: "Batas kuota, menunggu…",
  // Asleep is plain to see (closed eyes, z's): no label.
  sleeping: "",
  // Dizzy is just play (repeated clicks): the face says it all, no label.
  dizzy: "",
};
