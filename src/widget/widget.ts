// The widget: the character (bottom-right by default, draggable anywhere) and
// the panel next to it. It owns the chat and file state and decides what the
// character shows, with the priority approval > busy > error > celebration > idle.

import {
  Bridge,
  IS_TAURI,
  onEvent,
  type ChatEvent,
  type CopyResult,
  type FilePlan,
  type HitRect,
  type ScreenInfo,
} from "../core/bridge";
import { STATE_LABEL, type BotStateName } from "../core/layout";
import { Sound } from "../core/sound";
import { DEFAULT_SETTINGS, PROVIDERS, type Settings } from "../core/state";
import type { CharacterEmote, CharacterRenderer } from "../character/renderer";
import { MiuRenderer } from "../character/miu";
import { h, clear, svg } from "../views/dom";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A press that moves further than this is a drag, not a click. */
const DRAG_THRESHOLD = 5;

/** Speech-bubble icon for the chat button. */
function svgBubble(): SVGSVGElement {
  return svg("M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", 18, { stroke: 2 });
}

/** Body size at scale 1, CSS px. */
const BASE_BODY = 92;
/** Distance between the body and the bottom edge of the window. */
const FOOT = 10;
const PANEL_GAP = 14;
/** Default chat panel width (widget.css), and the window it fits in (widget.rs). */
const PANEL_W = 348;
const MIN_WIN_W = 380;
const MIN_WIN_H = 600;
/** Space between the panel and the window edges, both sides together. */
const PANEL_SIDES = 32;
/** Smallest chat panel the grip allows. */
const MIN_CHAT_W = 300;
const MIN_CHAT_H = 240;
const SLEEP_AFTER_MS = 5 * 60_000;
const DIZZY_MS = 3000;
const CELEBRATE_MS = 2200;
const LOVE_AFTER_MS = 1900;
/** States calm enough to dance in, as on macOS (BotCanvasView). */
const DANCE_STATES = new Set<BotStateName>(["idle", "working", "thinking", "searching", "finished"]);

const STATE_COLOR: Partial<Record<BotStateName, string>> = {
  working: "#3B9EFF",
  thinking: "#A78BFA",
  searching: "#6366F1",
  approval: "#F5A524",
  question: "#22D3EE",
  error: "#F4505E",
  finished: "#34D399",
  ratelimit: "#F59E0B",
  sleeping: "#94A3B8",
  dizzy: "#F472B6",
};

type ChatPhase = "idle" | "waiting" | "streaming" | "stopping";
type FilePhase = "none" | "confirm" | "copying";

export class Widget {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private renderer: CharacterRenderer = new MiuRenderer();
  private hasKey = false;
  private searching = false;

  // DOM
  private panel: HTMLElement;
  private subtitle: HTMLElement;
  private messages: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private status: HTMLElement;
  private statusText: HTMLElement;
  private statusDot: HTMLElement;
  private charWrap: HTMLElement;

  // Panel and chat
  private panelOpen = false;
  private chatPhase: ChatPhase = "idle";
  private activeRequest: number | null = null;
  private earlyEvents: ChatEvent[] = [];
  private answerEl: HTMLElement | null = null;

  // Files
  private filePhase: FilePhase = "none";
  private pendingPaths: string[] = [];
  private fileCard: HTMLElement | null = null;
  private dragOver = false;

  // Character
  private alert: "error" | "ratelimit" | null = null;
  private celebrateUntil = 0;
  private dizzyUntil = 0;
  private sleeping = false;
  private lastActivity = performance.now();
  private clickTimes: number[] = [];
  private lastReaction = -1;
  private hoverTimer: number | null = null;
  private chatBtn: HTMLElement;
  private chatBtnTimer: number | null = null;
  private menu: HTMLElement;
  private menuAt = { x: 0, y: 0 };
  /** Spotify is playing (media.rs). */
  private musicPlaying = false;
  private dancing = false;

  // Placement: the character's canvas top-left on screen, and the window's.
  private screenArea: ScreenInfo = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, scale: 1 };
  private charPos = { x: 0, y: 0 };
  private winPos = { x: Number.NaN, y: Number.NaN };
  private drag: { sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
  private dragFrame = 0;
  /** Corner handle that resizes the chat panel; sits outside its free corner. */
  private grip: HTMLElement;
  /** The panel corner away from the character: t/b + l/r. */
  private gripCorner = "tl";
  private resizing: { sx: number; sy: number; w: number; h: number } | null = null;
  private resizeFrame = 0;
  /** Window size last asked for (logical px), so it is only resized on a change. */
  private winSize = { w: MIN_WIN_W, h: MIN_WIN_H };
  private lastLove = 0;
  private shownState: BotStateName | null = null;

  constructor(root: HTMLElement) {
    this.statusDot = h("i", { class: "status-dot" });
    this.statusText = h("span", {});
    this.status = h("button", { class: "status", onclick: () => this.openPanel() }, this.statusDot, this.statusText);

    // Clicking the character is for playing with it; the chat opens from this
    // bubble (shown while the cursor is near), the right-click menu, the tray
    // icon or Ctrl+Alt+D.
    this.chatBtn = h("button", {
      class: "chat-bubble",
      title: "Buka chat (Ctrl+Alt+D)",
      "aria-label": "Buka chat",
      onclick: () => this.openPanel(),
    }, svgBubble());
    // Filled each time it opens (renderMenu).
    this.menu = h("div", { class: "menu", role: "menu" });

    this.subtitle = h("div", { class: "subtitle" });
    this.messages = h("div", { class: "messages" });
    this.input = h("textarea", {
      rows: 1,
      placeholder: "Tulis pesan…",
      spellcheck: "false",
    }) as HTMLTextAreaElement;
    this.sendBtn = h("button", { class: "send", title: "Kirim (Enter)" }) as HTMLButtonElement;

    this.panel = h(
      "section",
      { class: "panel", "aria-hidden": "true" },
      h(
        "header",
        { class: "panel-head" },
        h(
          "div",
          { class: "title-block" },
          h("div", { class: "title" }, h("span", { text: "Miu Lite" })),
          this.subtitle,
        ),
        h(
          "div",
          { class: "head-actions" },
          h("button", { class: "icon", title: "Percakapan baru", text: "↺", onclick: () => this.newChat() }),
          h("button", { class: "icon", title: "Pengaturan", text: "⚙", onclick: () => void Bridge.openSettingsWindow() }),
          h("button", { class: "icon", title: "Tutup (Esc)", text: "✕", onclick: () => this.closePanel() }),
        ),
      ),
      this.messages,
      h("footer", { class: "composer" }, this.input, this.sendBtn),
    );

    this.grip = h("div", {
      class: "panel-grip",
      title: "Tarik untuk mengubah ukuran chat. Klik dua kali untuk ukuran awal.",
    });

    this.charWrap = h("div", { class: "char-wrap" });
    root.append(this.panel, this.grip, this.status, this.charWrap, this.chatBtn, this.menu);
    this.attachRenderer();
    this.wireInput();
    this.wireGrip();
    this.renderEmpty();
    this.updateComposer();
  }

  // ── Boot ────────────────────────────────────────────────────────────────────

  async start() {
    // The launch greeting has its own score: give the sounds a moment to decode.
    const soundsReady = Promise.race([Sound.preload(), new Promise((r) => window.setTimeout(r, 1500))]);
    const boot = await Bridge.boot();
    if (boot) {
      this.settings = { ...this.settings, ...boot.settings };
      this.screenArea = boot.screen;
    }
    this.hasKey = await this.llmReady();
    this.applySettings();
    // The conversation from before the last exit (chat.json).
    for (const t of (await Bridge.chatHistory()) ?? []) {
      this.addBubble(t.user ? "user" : "model", t.text);
      if (!t.user && t.suggestions) this.addSuggestions(t.suggestions);
    }

    await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => this.onCursor(x, y));
    await onEvent<ChatEvent>("chat", (e) => this.onChat(e));
    await onEvent<Settings>("settings-changed", (s) => {
      this.settings = { ...this.settings, ...s };
      this.applySettings();
      void this.refreshKey();
    });
    await onEvent<boolean>("visibility", (visible) => {
      if (visible) {
        this.renderer.resume();
        this.pushHitRects();
      } else {
        this.renderer.pause();
      }
    });
    // Display plugged, rescaled or taskbar moved: place everything again.
    await onEvent<null>("screen-changed", async () => {
      const screen = await Bridge.screenInfo();
      if (screen) this.screenArea = screen;
      this.winPos = { x: Number.NaN, y: Number.NaN };
      this.placeFromSettings();
    });
    // Tray click / "Buka chat" (open) and Ctrl+Alt+D (toggle).
    await onEvent<string>("open-chat", (mode) => {
      if (mode === "toggle" && this.panelOpen) this.closePanel();
      else this.openPanel();
    });
    // Our own OLE drop target (src-tauri/src/platform/drop_target.rs).
    await onEvent<{ type: string; paths: string[] }>("file-drag", (e) => this.onDrag(e.type, e.paths));
    // Spotify started or stopped (src-tauri/src/media.rs).
    await onEvent<boolean>("music-playing", (on) => this.onMusic(on));
    this.onMusic((await Bridge.musicPlaying()) ?? false);

    window.setInterval(() => this.checkSleep(), 15_000);
    // The panel grows with its messages: the grip follows its corner.
    new ResizeObserver(() => {
      this.placeGrip();
      this.pushHitRects();
    }).observe(this.panel);
    // The window was resized for a resized panel (resize_widget): place
    // everything again, so the character stays where it stood.
    window.addEventListener("resize", () => this.place(this.charPos.x, this.charPos.y));
    new ResizeObserver(() => this.pushHitRects()).observe(this.status);
    new ResizeObserver(() => this.pushHitRects()).observe(this.menu);

    this.refreshState();
    window.setTimeout(() => void soundsReady.then(() => this.sayHello()), 500);
    // First run: no key or no model yet → open the panel on the setup note.
    if (!this.hasKey || !this.modelReady()) {
      window.setTimeout(() => this.openPanel(), 2200);
    }

    if (!IS_TAURI) this.browserPreview();
  }

  /** Puts the current renderer's canvas in place and makes its body clickable. */
  private attachRenderer() {
    const r = this.renderer;
    clear(this.charWrap);
    this.charWrap.append(r.canvas);
    // Left button: a click plays with the character, a drag moves it.
    r.canvas.addEventListener("pointerdown", (e) => {
      const b = r.body();
      if (Math.hypot(e.offsetX - b.cx, e.offsetY - b.cy) > b.r) return;
      if (e.button === 2) {
        this.showMenu(e.clientX, e.clientY);
        return;
      }
      if (e.button !== 0) return;
      this.drag = { sx: e.screenX, sy: e.screenY, ox: this.charPos.x, oy: this.charPos.y, moved: false };
      r.canvas.setPointerCapture(e.pointerId);
    });
    r.canvas.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.screenX - d.sx;
      const dy = e.screenY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        this.hideMenu();
        this.setChatBtn(false);
        r.canvas.classList.add("dragging");
        r.setDragged?.(true);
      }
      // One move per frame; the window follows the character.
      cancelAnimationFrame(this.dragFrame);
      this.dragFrame = requestAnimationFrame(() => this.place(d.ox + dx, d.oy + dy));
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      if (r.canvas.hasPointerCapture(e.pointerId)) r.canvas.releasePointerCapture(e.pointerId);
      r.canvas.classList.remove("dragging");
      r.setDragged?.(false);
      if (!d.moved) {
        if (e.type === "pointerup") this.onBodyClick();
        return;
      }
      // Dropped somewhere new: remember it, and a little landing bounce.
      this.settings.widgetX = Math.round(this.charPos.x);
      this.settings.widgetY = Math.round(this.charPos.y);
      void Bridge.saveSettings(this.settings);
      this.renderer.poke();
    };
    r.canvas.addEventListener("pointerup", end);
    r.canvas.addEventListener("pointercancel", end);
  }

  private sayHello() {
    if (this.renderer.playIntro) this.renderer.playIntro();
    else this.renderer.playEmote("greeting");
  }

  private applySettings() {
    Sound.setEnabled(this.settings.soundEnabled);
    Sound.setVolume(this.settings.soundVolume);
    const scale = Math.max(0.8, Math.min(1.4, this.settings.characterScale || 1));
    this.renderer.setSize(BASE_BODY * scale);
    this.renderer.setReducedMotion(this.settings.reducedMotion);
    this.refreshDance();
    this.placeFromSettings();
    // A saved chat size may need a bigger window (or the default one back).
    this.syncWindowSize();
    this.updateSubtitle();
    if (this.messages.querySelector(".empty")) this.renderEmpty();
  }

  /** The Gemini key is saved. */
  private async llmReady(): Promise<boolean> {
    return this.settings.provider === "ollama" || ((await Bridge.secretPresent(PROVIDERS[this.settings.provider].key)) ?? false);
  }

  private modelReady(): boolean {
    return !!this.settings.model;
  }

  private async refreshKey() {
    this.hasKey = await this.llmReady();
    if (this.messages.querySelector(".empty")) this.renderEmpty();
  }

  // ── Layout and click-through ────────────────────────────────────────────────

  /** The saved spot, or bottom-right of the work area by default. */
  private placeFromSettings() {
    const { widgetX, widgetY } = this.settings;
    if (widgetX != null && widgetY != null) this.place(widgetX, widgetY);
    else {
      const p = this.defaultCharPos();
      this.place(p.x, p.y);
    }
  }

  /** Where the character stood before it could be moved: the bottom-right corner. */
  private defaultCharPos() {
    const r = this.renderer;
    const s = IS_TAURI ? this.screenArea : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    return {
      x: s.x + s.width - 12 - r.width,
      y: s.y + s.height - 8 - FOOT + r.footGap - r.height,
    };
  }

  private resetPosition() {
    this.settings.widgetX = null;
    this.settings.widgetY = null;
    void Bridge.saveSettings(this.settings);
    this.placeFromSettings();
  }

  /**
   * Puts the character's canvas at (x, y) on screen. The window (a fixed
   * 380 × 600) stays inside the work area and reaches from the character
   * towards the middle of the screen, so the character can stand in any
   * corner and the panel always opens on the roomy side.
   */
  private place(x: number, y: number) {
    const r = this.renderer;
    const b = r.body();
    const W = window.innerWidth;
    const H = window.innerHeight;
    // In a plain browser the page itself stands in for the screen.
    const s = IS_TAURI ? this.screenArea : { x: 0, y: 0, width: W, height: H, scale: 1 };

    // The body stays on screen; the transparent canvas margin may not.
    x = clamp(x, s.x - (b.cx - b.r), s.x + s.width - (b.cx + b.r));
    y = clamp(y, s.y - (b.cy - b.r), s.y + s.height - (r.height - r.footGap));
    this.charPos = { x, y };

    const onRight = x + b.cx > s.x + s.width / 2;
    const onLow = y + b.cy > s.y + s.height / 2;
    const wx = clamp(onRight ? x + r.width + 4 - W : x - 4, s.x, s.x + Math.max(0, s.width - W));
    const wy = clamp(onLow ? y + r.height - r.footGap + FOOT - H : y - 6, s.y, s.y + Math.max(0, s.height - H));
    if (IS_TAURI && (Math.round(wx) !== Math.round(this.winPos.x) || Math.round(wy) !== Math.round(this.winPos.y))) {
      void Bridge.moveWidget(wx, wy);
    }
    this.winPos = { x: wx, y: wy };

    // Everything below in window coordinates.
    const lx = x - (IS_TAURI ? wx : 0);
    const ly = y - (IS_TAURI ? wy : 0);
    this.charWrap.style.left = `${lx}px`;
    this.charWrap.style.top = `${ly}px`;
    const bodyLeft = lx + b.cx - b.r;
    const bodyRight = lx + b.cx + b.r;
    const headTop = ly + b.cy - b.r;
    const feet = ly + r.height - r.footGap;

    // Status pill beside the body, towards the middle of the window.
    setSides(this.status, onRight ? { right: W - bodyLeft + 8 } : { left: bodyRight + 8 }, { top: ly + b.cy - 14 });
    // Chat bubble by the head, on the same side.
    setSides(
      this.chatBtn,
      { left: onRight ? lx + b.cx - b.r * 0.55 - 38 : lx + b.cx + b.r * 0.55 },
      { top: headTop - 8 },
    );

    // Panel: above the head or below the feet, whichever
    // has more room, flush with the window edge on the character's side.
    const above = headTop - PANEL_GAP - 8;
    const below = H - feet - PANEL_GAP - 8;
    const horizontal = onRight ? { right: 10 } : { left: 10 };
    // The user's chat size (grip), never wider than the window allows; the
    // height is capped by maxHeight below like the default one.
    const { chatWidth, chatHeight } = this.settings;
    this.panel.style.width = chatWidth != null ? `${Math.min(chatWidth, W - PANEL_SIDES)}px` : "";
    this.panel.style.height = chatHeight != null ? `${chatHeight}px` : "";
    this.gripCorner = (above >= below ? "t" : "b") + (onRight ? "l" : "r");
    if (above >= below) {
      setSides(this.panel, horizontal, { bottom: H - headTop + PANEL_GAP });
      this.panel.style.maxHeight = `${Math.max(120, headTop - PANEL_GAP - 8)}px`;
    } else {
      setSides(this.panel, horizontal, { top: feet + PANEL_GAP });
      this.panel.style.maxHeight = `${Math.max(120, H - feet - PANEL_GAP - 8)}px`;
    }
    this.placeGrip();
    this.pushHitRects();
  }

  // ── Chat panel size ─────────────────────────────────────────────────────────

  /** Height from the top of the head to the window edge below the feet, or
   *  from the window edge above the canvas to the feet: what the window needs
   *  besides the panel, whichever side the panel opens on. */
  private charSpan(): number {
    const r = this.renderer;
    const b = r.body();
    const toFeet = r.height - r.footGap;
    return Math.max(toFeet - (b.cy - b.r) + FOOT, toFeet + 6);
  }

  /** Window size for the current chat size: the default 380 × 600 or more. */
  private wantedWindowSize() {
    const { chatWidth, chatHeight } = this.settings;
    const w = Math.max(MIN_WIN_W, (chatWidth ?? PANEL_W) + PANEL_SIDES);
    const h = chatHeight == null ? MIN_WIN_H : Math.max(MIN_WIN_H, chatHeight + PANEL_GAP + 8 + this.charSpan());
    return { w: Math.round(w), h: Math.round(h) };
  }

  /** Asks Rust for the window size the chat needs, when it changed. The
   *  window's resize event then places everything again. */
  private syncWindowSize() {
    if (!IS_TAURI) return;
    const want = this.wantedWindowSize();
    if (want.w === this.winSize.w && want.h === this.winSize.h) return;
    this.winSize = want;
    void Bridge.resizeWidget(want.w, want.h);
  }

  /** Largest chat that fits on this screen next to the character. */
  private chatLimits() {
    const s = IS_TAURI ? this.screenArea : { width: window.innerWidth, height: window.innerHeight };
    return {
      maxW: Math.max(MIN_CHAT_W, s.width - 16 - PANEL_SIDES),
      maxH: Math.max(MIN_CHAT_H, s.height - 16 - PANEL_GAP - 8 - this.charSpan()),
    };
  }

  private setChatSize(w: number, h: number) {
    const { maxW, maxH } = this.chatLimits();
    this.settings.chatWidth = Math.round(clamp(w, MIN_CHAT_W, maxW));
    this.settings.chatHeight = Math.round(clamp(h, MIN_CHAT_H, maxH));
    cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      this.syncWindowSize();
      this.place(this.charPos.x, this.charPos.y);
    });
  }

  /** The grip sits just outside the panel's free corner (the panel clips its
   *  own rounded corners, and the other top corner holds the ✕ button). */
  private placeGrip() {
    const on = this.panel.classList.contains("on");
    this.grip.classList.toggle("on", on);
    if (!on) return;
    // Layout box, not getBoundingClientRect: the opening animation transforms
    // the panel for a moment. Grip and panel share the same container.
    const p = this.panel;
    const size = 18;
    const top = this.gripCorner[0] === "t";
    const left = this.gripCorner[1] === "l";
    this.grip.dataset.corner = this.gripCorner;
    this.grip.style.left = `${(left ? p.offsetLeft : p.offsetLeft + p.offsetWidth) - size / 2}px`;
    this.grip.style.top = `${(top ? p.offsetTop : p.offsetTop + p.offsetHeight) - size / 2}px`;
  }

  /** Drag the grip to resize the chat; double-click for the default size. */
  private wireGrip() {
    const g = this.grip;
    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const p = this.panel.getBoundingClientRect();
      // Screen coordinates: the window itself moves and grows while dragging.
      this.resizing = { sx: e.screenX, sy: e.screenY, w: p.width, h: p.height };
      g.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing-chat");
    });
    g.addEventListener("pointermove", (e) => {
      const z = this.resizing;
      if (!z) return;
      const dx = e.screenX - z.sx;
      const dy = e.screenY - z.sy;
      // The corner moves away from the character's side.
      const left = this.gripCorner[1] === "l";
      const top = this.gripCorner[0] === "t";
      this.setChatSize(z.w + (left ? -dx : dx), z.h + (top ? -dy : dy));
    });
    const end = (e: PointerEvent) => {
      if (!this.resizing) return;
      this.resizing = null;
      if (g.hasPointerCapture(e.pointerId)) g.releasePointerCapture(e.pointerId);
      document.body.classList.remove("resizing-chat");
      void Bridge.saveSettings(this.settings);
    };
    g.addEventListener("pointerup", end);
    g.addEventListener("pointercancel", end);
    g.addEventListener("dblclick", () => {
      this.settings.chatWidth = null;
      this.settings.chatHeight = null;
      void Bridge.saveSettings(this.settings);
      this.syncWindowSize();
      this.place(this.charPos.x, this.charPos.y);
    });
  }

  private bodyRect(): { cx: number; cy: number; r: number } {
    const rect = this.renderer.canvas.getBoundingClientRect();
    const b = this.renderer.body();
    return { cx: rect.left + b.cx, cy: rect.top + b.cy, r: b.r };
  }

  /** Everything outside these shapes lets clicks through to the desktop. */
  private pushHitRects() {
    const rects: HitRect[] = [];
    const b = this.bodyRect();
    rects.push({ x: b.cx - b.r, y: b.cy - b.r, w: b.r * 2, h: b.r * 2 });
    for (const el of [this.panel, this.grip, this.status, this.chatBtn, this.menu]) {
      if (!el.classList.contains("on")) continue;
      const r = el.getBoundingClientRect();
      rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    void Bridge.setHitRects(rects);
  }

  // ── Character state (PRD §4) ────────────────────────────────────────────────

  private effectiveState(): BotStateName {
    const now = performance.now();
    if (now < this.dizzyUntil) return "dizzy";
    if (this.filePhase === "confirm") return "approval";
    if (this.filePhase === "copying") return "working";
    if (this.chatPhase !== "idle") return this.searching ? "searching" : "thinking";
    if (this.alert) return this.alert;
    if (now < this.celebrateUntil) return "finished";
    if (this.sleeping) return "sleeping";
    return "idle";
  }

  private refreshState() {
    const state = this.effectiveState();
    if (state !== this.shownState) {
      const prev = this.shownState;
      this.shownState = state;
      this.renderer.setState(state);
      if (prev !== null) this.playStateSound(state);
    }
    let label = STATE_LABEL[state];
    if (this.dragOver) label = "Jatuhkan file ke aku";
    else if (state === "thinking" && this.chatPhase === "streaming") label = "Menjawab…";
    else if (state === "thinking" && this.chatPhase === "stopping") label = "Menghentikan…";
    this.statusText.textContent = label;
    this.statusDot.style.background = STATE_COLOR[state] ?? "#E6E9EE";
    this.status.classList.toggle("on", label !== "" && !this.panelOpen);
    this.updateSubtitle();
    this.refreshDance();
  }

  // ── Music (Spotify) ─────────────────────────────────────────────────────────

  private onMusic(on: boolean) {
    this.musicPlaying = on;
    // Music counts as company: wake up and stay awake while it plays, and
    // count the five sleepy minutes from when it stops.
    if (this.settings.danceToMusic) {
      if (on) this.markActivity();
      else this.lastActivity = performance.now();
    }
    this.refreshDance();
  }

  /** Dance while Spotify plays, in calm states only (busy, thinking and done are fine). */
  private refreshDance() {
    const on = this.musicPlaying && this.settings.danceToMusic && DANCE_STATES.has(this.shownState ?? "idle");
    if (on === this.dancing) return;
    this.dancing = on;
    this.renderer.setDancing?.(on);
  }

  private playStateSound(state: BotStateName) {
    const sound: Partial<Record<BotStateName, string>> = {
      approval: "approval", error: "error", finished: "finish", ratelimit: "rate", dizzy: "dizzy",
    };
    const name = sound[state];
    if (name) Sound.play(name);
  }

  private updateSubtitle() {
    const model = this.settings.model || "model belum dipilih";
    const text = this.statusText.textContent || STATE_LABEL[this.effectiveState()];
    this.subtitle.textContent = `${PROVIDERS[this.settings.provider].label} · ${model}${text ? ` · ${text}` : ""}`;
  }

  private celebrate() {
    this.celebrateUntil = performance.now() + CELEBRATE_MS;
    this.refreshState();
    window.setTimeout(() => this.refreshState(), CELEBRATE_MS + 50);
  }

  private markActivity() {
    this.lastActivity = performance.now();
    if (this.sleeping) {
      this.sleeping = false;
      this.refreshState();
      this.renderer.playEmote("yawn");
    }
  }

  private checkSleep() {
    if (this.sleeping || this.panelOpen || this.dancing || this.effectiveState() !== "idle") return;
    if (performance.now() - this.lastActivity > SLEEP_AFTER_MS) {
      this.sleeping = true;
      this.refreshState();
    }
  }

  // ── Pointer ─────────────────────────────────────────────────────────────────

  /** Cursor in window coordinates (from the Rust poll, ~60 Hz). */
  private onCursor(x: number, y: number) {
    const b = this.bodyRect();
    const dx = x - b.cx;
    const dy = y - b.cy;
    this.renderer.setLook(Math.tanh(dx / 260), -Math.tanh(dy / 200));

    const dist = Math.hypot(dx, dy);
    if (dist < 220) this.markActivity();

    // The chat bubble shows while the cursor is around the character, and
    // lingers a moment so it can be reached.
    const near = dist < 190 && !this.panelOpen;
    if (near) {
      if (this.chatBtnTimer != null) window.clearTimeout(this.chatBtnTimer);
      this.chatBtnTimer = null;
      this.setChatBtn(true);
    } else if (this.chatBtn.classList.contains("on") && this.chatBtnTimer == null) {
      this.chatBtnTimer = window.setTimeout(() => {
        this.chatBtnTimer = null;
        this.setChatBtn(false);
      }, 1200);
    }
    // A menu left behind closes once the cursor wanders off, away from both
    // the menu and the character it opened from.
    if (this.menu.classList.contains("on")) {
      const m = this.menu.getBoundingClientRect();
      const mx = Math.max(m.left - x, 0, x - m.right);
      const my = Math.max(m.top - y, 0, y - m.bottom);
      if (Math.hypot(mx, my) > 120 && dist - b.r > 120) this.hideMenu();
    }

    const over = dist <= b.r;
    if (over && this.hoverTimer == null) {
      this.hoverTimer = window.setTimeout(() => {
        this.hoverTimer = null;
        const now = performance.now();
        if (this.effectiveState() !== "idle" || now - this.lastLove < 6000) return;
        this.lastLove = now;
        this.renderer.playEmote("love");
        Sound.play("love");
      }, LOVE_AFTER_MS);
    } else if (!over && this.hoverTimer != null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  private onBodyClick() {
    Sound.resume();
    this.markActivity();
    const now = performance.now();
    this.clickTimes = this.clickTimes.filter((t) => now - t < 1700);
    this.clickTimes.push(now);
    if (this.clickTimes.length >= 3) {
      // Repeated clicks make it dizzy; this never changes any task state.
      this.clickTimes = [];
      this.dizzyUntil = now + DIZZY_MS;
      this.refreshState();
      window.setTimeout(() => {
        this.refreshState();
        this.renderer.playEmote("happy");
      }, DIZZY_MS + 50);
      return;
    }
    // A click is for play: a squash and a little reaction, never the chat.
    this.renderer.poke();
    const reactions: [CharacterEmote, string][] = [
      ["happy", "pop"], ["love", "love"], ["surprised", "blip"], ["proud", "proud"], ["wink", "wink"],
    ];
    let i = Math.floor(Math.random() * reactions.length);
    if (i === this.lastReaction) i = (i + 1) % reactions.length;
    this.lastReaction = i;
    const [emote, sound] = reactions[i];
    this.renderer.playEmote(emote);
    Sound.play(sound);
  }

  private setChatBtn(on: boolean) {
    if (this.chatBtn.classList.contains("on") === on) return;
    this.chatBtn.classList.toggle("on", on);
    this.pushHitRects();
  }

  private showMenu(x: number, y: number) {
    this.menuAt = { x, y };
    this.renderMenu();
    this.menu.classList.add("on");
    this.positionMenu();
  }

  /**
   * Never over the character: beside it on the roomy side of the window, or
   * above / below it when there is no room beside. The area kept clear covers
   * the body and the tallest hats; the cursor spot is the last resort.
   */
  private positionMenu() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const m = this.menu.getBoundingClientRect();
    const b = this.bodyRect();
    const gap = 8;
    const keep = { left: b.cx - b.r * 1.3, right: b.cx + b.r * 1.3, top: b.cy - b.r * 2.4, bottom: b.cy + b.r * 1.1 };
    const fitsX = (left: number) => left >= 6 && left + m.width <= W - 6;
    const fitsY = (top: number) => top >= 6 && top + m.height <= H - 6;
    const clampX = (left: number) => clamp(left, 6, Math.max(6, W - m.width - 6));
    const clampY = (top: number) => clamp(top, 6, Math.max(6, H - m.height - 6));

    // Beside: towards the middle of the window first, then the other side.
    const sides = b.cx > W / 2
      ? [keep.left - gap - m.width, keep.right + gap]
      : [keep.right + gap, keep.left - gap - m.width];
    // Above or below: whichever has more room first.
    const rows = keep.top >= H - keep.bottom
      ? [keep.top - gap - m.height, keep.bottom + gap]
      : [keep.bottom + gap, keep.top - gap - m.height];

    let left: number;
    let top: number;
    const side = sides.find(fitsX);
    const row = rows.find(fitsY);
    if (side !== undefined) {
      left = side;
      // Level with the body, bottoms aligned, inside the window.
      top = clampY(b.cy + b.r - m.height);
    } else if (row !== undefined) {
      top = row;
      left = clampX(b.cx > W / 2 ? keep.right - m.width : keep.left);
    } else {
      left = clampX(this.menuAt.x - m.width + 10);
      top = clampY(this.menuAt.y - m.height - 4);
    }
    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${top}px`;
    this.pushHitRects();
  }

  private renderMenu() {
    clear(this.menu);
    const item = (text: string, action: () => void) =>
      h("button", { role: "menuitem", text, onclick: () => { this.hideMenu(); action(); } });
    this.menu.append(
      item("Buka chat", () => this.openPanel()),
      item("Pengaturan…", () => void Bridge.openSettingsWindow()),
      item("Kembalikan ke pojok", () => this.resetPosition()),
      item("Sembunyikan", () => void Bridge.hideWidget()),
      h("hr", {}),
      h("button", { role: "menuitem", text: "Keluar", onclick: () => void Bridge.quit() }),
    );
  }

  private hideMenu() {
    if (!this.menu.classList.contains("on")) return;
    this.menu.classList.remove("on");
    this.pushHitRects();
  }

  private wireInput() {
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    this.input.addEventListener("input", () => this.autoGrow());
    this.sendBtn.addEventListener("click", () => {
      if (this.chatPhase === "idle") void this.send();
      else this.stop();
    });

    // No browser context menu anywhere in the widget; our own one on the body.
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("pointerdown", (e) => {
      if (!this.menu.contains(e.target as Node)) this.hideMenu();
    }, true);

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (this.menu.classList.contains("on")) {
        this.hideMenu();
        return;
      }
      if (this.chatPhase === "waiting" || this.chatPhase === "streaming") this.stop();
      else this.closePanel();
    });

    // In a plain browser there is no Rust cursor poll.
    if (!IS_TAURI) {
      document.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    }
  }

  // ── Panel ───────────────────────────────────────────────────────────────────

  private openPanel() {
    if (this.panelOpen) return;
    this.panelOpen = true;
    this.markActivity();
    this.hideMenu();
    this.setChatBtn(false);
    this.panel.classList.add("on");
    this.panel.setAttribute("aria-hidden", "false");
    this.placeGrip();
    Sound.play("open");
    void this.refreshKey();
    this.refreshState();
    void Bridge.focusWindow(true);
    window.setTimeout(() => this.input.focus(), 60);
    this.pushHitRects();
  }

  private closePanel() {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    this.panel.classList.remove("on");
    this.panel.setAttribute("aria-hidden", "true");
    this.placeGrip();
    Sound.play("close");
    this.input.blur();
    void Bridge.focusWindow(false);
    // Closing the panel acknowledges a shown error (PRD §4).
    if (this.alert && this.chatPhase === "idle") this.alert = null;
    this.refreshState();
    this.pushHitRects();
  }

  private autoGrow() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(110, this.input.scrollHeight)}px`;
  }

  private updateComposer() {
    const busy = this.chatPhase !== "idle";
    this.sendBtn.textContent = busy ? "■" : "➤";
    this.sendBtn.title = busy ? "Stop (Esc)" : "Kirim (Enter)";
    this.sendBtn.classList.toggle("stop", busy);
    this.sendBtn.disabled = this.chatPhase === "stopping";
  }

  private scrollToEnd() {
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private renderEmpty() {
    clear(this.messages);
    const box = h(
      "div",
      { class: "empty" },
      h("p", { text: "Halo! Aku Miu." }),
      h("p", {
        text: "Tanyakan apa saja, atau jatuhkan file ke aku untuk disalin ke folder yang rapi.",
      }),
    );
    if (!this.hasKey || !this.modelReady()) {
      box.append(
        h(
          "div",
          { class: "note warn" },
          h("span", {
            text: !this.hasKey ? "Isi API key penyedia dulu, lalu pilih model." : "Pilih model dulu.",
          }),
          h("button", { text: "Buka Pengaturan", onclick: () => void Bridge.openSettingsWindow() }),
        ),
      );
    }
    this.messages.append(box);
  }

  private addBubble(role: "user" | "model", text: string): HTMLElement {
    this.messages.querySelector(".empty")?.remove();
    const el = h("div", { class: `bubble ${role}`, text });
    this.messages.append(el);
    this.linkifyAnswers();
    this.scrollToEnd();
    return el;
  }

  private addSuggestions(html: string) {
        const frame = h("iframe", { title: "Saran pencarian Google", sandbox: "allow-popups allow-popups-to-escape-sandbox", style: "width:100%;height:120px;border:0;background:white;border-radius:8px" });
        frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:">${html}`;
        this.messages.append(frame);
        this.scrollToEnd();
  }

  private linkifyAnswers() {
    for (const bubble of this.messages.querySelectorAll<HTMLElement>(".bubble.model")) {
      if (bubble.querySelector("a")) continue;
      const text = bubble.textContent || "";
      clear(bubble);
      let at = 0;
      for (const match of text.matchAll(/https?:\/\/[^\s<>]+/g)) {
        const url = match[0].replace(/[),.;]+$/, "");
        const index = match.index!;
        bubble.append(document.createTextNode(text.slice(at, index)));
        bubble.append(h("a", { href: url, text: url, style: "color:inherit;text-decoration:underline;overflow-wrap:anywhere", onclick: (event: Event) => { event.preventDefault(); void Bridge.openUrl(url); } }));
        at = index + url.length;
      }
      bubble.append(document.createTextNode(text.slice(at)));
    }
  }

  private addNote(text: string, kind: "info" | "tool" | "warn" | "err" = "info", withSettings = false): HTMLElement {
    this.messages.querySelector(".empty")?.remove();
    const el = h("div", { class: `note ${kind}` }, h("span", { text }));
    if (withSettings) {
      el.append(h("button", { text: "Buka Pengaturan", onclick: () => void Bridge.openSettingsWindow() }));
    }
    this.messages.append(el);
    this.scrollToEnd();
    return el;
  }

  // ── Chat ────────────────────────────────────────────────────────────────────

  private async send() {
    if (this.chatPhase !== "idle") return;
    const text = this.input.value.trim();
    if (!text) return;
    this.markActivity();
    this.alert = null;
    this.input.value = "";
    this.autoGrow();
    this.addBubble("user", text);
    this.answerEl = null;
    this.earlyEvents = [];
    this.chatPhase = "waiting";
    this.updateComposer();
    this.refreshState();
    Sound.play("send");

    try {
      const id = await Bridge.chatSend(text);
      this.activeRequest = id;
      const early = this.earlyEvents.filter((e) => e.requestId === id);
      this.earlyEvents = [];
      for (const e of early) this.onChat(e);
    } catch (err) {
      const message = String(err).replace(/^Error:\s*/, "");
      this.chatPhase = "idle";
      this.alert = "error";
      this.addNote(message, "err", /Pengaturan/.test(message));
      this.updateComposer();
      this.refreshState();
    }
  }

  private stop() {
    if (this.chatPhase !== "waiting" && this.chatPhase !== "streaming") return;
    this.chatPhase = "stopping";
    this.updateComposer();
    this.refreshState();
    void Bridge.chatStop();
  }

  private newChat() {
    if (this.chatPhase !== "idle") void Bridge.chatStop();
    void Bridge.chatReset();
    this.chatPhase = "idle";
    this.searching = false;
    this.activeRequest = null;
    this.answerEl = null;
    this.alert = null;
    if (this.filePhase !== "copying") {
      this.filePhase = "none";
      this.pendingPaths = [];
      this.fileCard = null;
    }
    this.renderEmpty();
    this.updateComposer();
    this.refreshState();
    this.input.focus();
  }

  private onChat(e: ChatEvent) {
    if (this.activeRequest === null) {
      // The event beat the invoke reply: keep it until we know our ID.
      if (this.chatPhase !== "idle") this.earlyEvents.push(e);
      return;
    }
    if (e.requestId !== this.activeRequest) return;

    switch (e.kind) {
      case "search":
        if (this.chatPhase === "stopping") return;
        this.searching = true;
        this.refreshState();
        this.addNote(e.text, "tool");
        return;
      case "suggestions": {
        if (this.chatPhase === "stopping") return;
        this.addSuggestions(e.text);
        return;
      }
      case "delta": {
        this.searching = false;
        if (this.chatPhase === "stopping") return;
        if (this.chatPhase === "waiting") {
          this.chatPhase = "streaming";
          this.refreshState();
        }
        if (!this.answerEl) this.answerEl = this.addBubble("model", "");
        this.answerEl.textContent += e.text;
        this.scrollToEnd();
        return;
      }
      case "tool":
        // Show the step, and put whatever the model says next below it.
        if (this.chatPhase === "stopping") return;
        this.addNote(e.text, "tool");
        this.answerEl = null;
        return;
      case "done":
        this.linkifyAnswers();
        if (e.text) this.addNote(e.text, "info");
        this.renderer.playEmote("happy");
        Sound.play("pop");
        break;
      case "stopped":
        this.addNote("Dihentikan.", "info");
        break;
      case "error":
        this.alert = e.code === "ratelimit" ? "ratelimit" : "error";
        this.addNote(e.text, "err", e.code === "key" || e.code === "model");
        break;
    }
    this.searching = false;
    this.activeRequest = null;
    this.answerEl = null;
    this.chatPhase = "idle";
    this.updateComposer();
    this.refreshState();
  }

  // ── Files (PRD §6) ──────────────────────────────────────────────────────────

  private onDrag(type: string, paths: string[]) {
    switch (type) {
      case "enter":
      case "over":
        if (this.dragOver) return;
        this.dragOver = true;
        this.markActivity();
        this.renderer.setDropHover(true);
        this.refreshState();
        break;
      case "leave":
        if (!this.dragOver) return;
        this.dragOver = false;
        this.renderer.setDropHover(false);
        this.refreshState();
        break;
      case "drop":
        this.dragOver = false;
        if (paths.length === 0) {
          this.renderer.setDropHover(false);
          this.refreshState();
          return;
        }
        this.renderer.swallow();
        Sound.play("gulp");
        void this.planDrop(paths);
        break;
    }
  }

  private async planDrop(paths: string[]) {
    this.openPanel();
    if (this.filePhase === "copying") {
      this.addNote("Tunggu, penyalinan sebelumnya belum selesai.", "warn");
      return;
    }
    if (this.filePhase === "confirm" && this.fileCard) {
      this.fileCard.querySelector(".card-actions")?.remove();
      this.fileCard.append(h("div", { class: "card-foot", text: "Diganti oleh file yang baru dijatuhkan." }));
    }
    this.alert = null;

    let plan: FilePlan;
    try {
      plan = await Bridge.filesPlan(paths);
    } catch (err) {
      this.alert = "error";
      this.addNote(String(err).replace(/^Error:\s*/, ""), "err");
      this.refreshState();
      return;
    }

    const ready = plan.items.filter((i) => !i.error);
    const card = h("div", { class: "card" });
    const list = h("ul", { class: "file-list" });
    for (const item of plan.items) {
      list.append(
        item.error
          ? h("li", { class: "bad" }, h("b", { text: item.name }), h("span", { text: item.error }))
          : h(
              "li",
              {},
              h("b", { text: item.name }),
              h("span", {
                text: item.renamed
                  ? `→ ${item.folder}, sebagai "${item.destName}" (nama sudah ada)`
                  : `→ ${item.folder}`,
              }),
            ),
      );
    }
    card.append(
      h("div", { class: "card-title", text: ready.length ? `${ready.length} file siap disalin` : "Tidak ada file yang bisa disalin" }),
      h("div", {
        class: "card-sub",
        text: `Folder: ${plan.root}${plan.rootExists ? "" : " (akan dibuat)"}. File asli tidak diubah.`,
      }),
      list,
    );
    this.messages.querySelector(".empty")?.remove();
    this.messages.append(card);
    this.fileCard = card;
    this.scrollToEnd();

    if (ready.length === 0) {
      this.filePhase = "none";
      this.alert = "error";
      this.refreshState();
      return;
    }

    this.pendingPaths = paths;
    this.filePhase = "confirm";
    const copyBtn = h("button", { class: "primary", text: `Salin ${ready.length} file` });
    const cancelBtn = h("button", { text: "Batal" });
    copyBtn.addEventListener("click", () => void this.copyFiles(card));
    cancelBtn.addEventListener("click", () => {
      if (this.fileCard !== card || this.filePhase !== "confirm") return;
      this.filePhase = "none";
      this.pendingPaths = [];
      card.querySelector(".card-actions")?.remove();
      card.append(h("div", { class: "card-foot", text: "Dibatalkan. Tidak ada file yang disalin." }));
      this.refreshState();
    });
    card.append(h("div", { class: "card-actions" }, copyBtn, cancelBtn));
    this.refreshState();
  }

  private async copyFiles(card: HTMLElement) {
    if (this.fileCard !== card || this.filePhase !== "confirm") return;
    this.filePhase = "copying";
    card.querySelectorAll<HTMLButtonElement>(".card-actions button").forEach((b) => (b.disabled = true));
    this.refreshState();

    let results: CopyResult[];
    try {
      results = await Bridge.filesCopy(this.pendingPaths);
    } catch (err) {
      results = [];
      this.addNote(String(err).replace(/^Error:\s*/, ""), "err");
    }
    this.filePhase = "none";
    this.pendingPaths = [];
    card.querySelector(".card-actions")?.remove();
    card.querySelector(".file-list")?.remove();

    const ok = results.filter((r) => r.ok);
    const failed = results.length - ok.length;
    const list = h("ul", { class: "file-list" });
    for (const r of results) {
      if (r.ok && r.destPath) {
        const dest = r.destPath;
        const name = dest.split(/[\\/]/).pop() ?? r.name;
        list.append(
          h(
            "li",
            { class: "good" },
            h("b", { text: `✓ ${name}` }),
            h("span", { text: `${r.folder} · ${formatSize(r.size)}` }),
            h("button", {
              class: "link",
              text: "Tampilkan",
              onclick: () => void Bridge.filesReveal(dest).catch(() => {}),
            }),
          ),
        );
      } else {
        list.append(h("li", { class: "bad" }, h("b", { text: `✗ ${r.name}` }), h("span", { text: r.error ?? "Gagal" })));
      }
    }
    const title = card.querySelector(".card-title");
    if (title) {
      title.textContent = failed === 0
        ? `${ok.length} file tersalin dan terverifikasi`
        : `${ok.length} tersalin, ${failed} gagal`;
    }
    card.append(list);
    this.scrollToEnd();

    // "Finished" only for a verified result: every copy checked by size.
    if (results.length > 0 && failed === 0) {
      this.celebrate();
    } else {
      this.alert = "error";
      this.refreshState();
    }
  }

  // ── Browser preview (npm run dev) ───────────────────────────────────────────

  private browserPreview() {
    // ?bubble / ?menu: show the chat bubble or the right-click menu (no hover in tests).
    if (location.search.includes("bubble")) window.setTimeout(() => this.setChatBtn(true), 2600);
    if (location.search.includes("menu")) {
      window.setTimeout(() => {
        const b = this.bodyRect();
        this.showMenu(b.cx, b.cy);
      }, 2600);
    }
    // ?pos=tl: the character dragged to the top-left (panel opens below).
    if (location.search.includes("pos=tl")) this.place(0, 0);
    if (!location.search.includes("demo")) return;
    this.hasKey = true;
    this.settings.model = "gemini-3.6-flash";
    this.openPanel();
    this.addBubble("user", "Halo Miu, tolong ringkas jadwal rapat besok jadi tiga poin.");
    this.addBubble(
      "model",
      "Tentu! Ringkasannya:\n1. 09.00 rapat tim riset, bahas progres prototipe.\n2. 13.00 review PRD 1.2 bersama dosen.\n3. 15.30 uji widget Miu Lite.",
    );
    this.addNote("Contoh tampilan di browser; chat sungguhan hanya di aplikasi desktop.", "info");
    this.refreshState();
  }
}

/** Positions an absolutely placed element by the given sides; the others go auto. */
function setSides(
  el: HTMLElement,
  h: { left?: number; right?: number },
  v: { top?: number; bottom?: number },
) {
  el.style.left = h.left != null ? `${h.left}px` : "auto";
  el.style.right = h.right != null ? `${h.right}px` : "auto";
  el.style.top = v.top != null ? `${v.top}px` : "auto";
  el.style.bottom = v.bottom != null ? `${v.bottom}px` : "auto";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
