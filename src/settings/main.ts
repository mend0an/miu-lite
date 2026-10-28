// Settings window: the Gemini key and model, the character and general
// preferences, and the drop folder. The key is write-only from here: the page
// can store or remove it, and ask whether it exists, but never read it back.

import "./settings.css";
import { llmSection } from "./llm";
import { Bridge, onEvent, type Fact } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";
let dropRoot = "";
const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

function errText(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    el.setAttribute("aria-pressed", String(next));
    onChange(next);
  });
  return el;
}


function notice(kind: "ok" | "err" | "warn", text: string): HTMLElement {
  return h("div", { class: `notice ${kind}`, text });
}

// ── Gemini ────────────────────────────────────────────────────────────────────


function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("change", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const size = h("input", {
    type: "range", min: "0.8", max: "1.4", step: "0.05",
    value: String(settings.characterScale),
  }) as HTMLInputElement;
  size.addEventListener("change", () => {
    settings.characterScale = Number(size.value);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Layar utama" }),
    h("option", { value: "cursor", text: "Layar tempat kursor saat dibuka" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Karakter dan umum" })),
    h("div", { class: "row" },
      h("label", { text: "Goyang ikut musik" }),
      toggle(settings.danceToMusic, (v) => { settings.danceToMusic = v; void save(); }),
      h("span", { class: "hint", text: "Saat Spotify memutar lagu." }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Ukuran karakter" }),
      size,
    ),
    h("div", { class: "row" },
      h("label", { text: "Kurangi gerakan" }),
      toggle(settings.reducedMotion, (v) => { settings.reducedMotion = v; void save(); }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Suara" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Tampil di" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Jalan saat Windows mulai" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
      h("span", { class: "hint", text: "Exe portable: matikan dulu sebelum memindahkan foldernya." }),
    ),
  );
}

// ── Memory ────────────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = { chat: "dari chat", ringkasan: "dari ringkasan" };

/** Rebuilt whenever the facts change (memory-changed). */
let reloadFacts: () => Promise<void> = async () => {};

function memorySection(): HTMLElement {
  const list = h("ul", { class: "facts" });
  const count = h("div", { class: "hint" });
  const feedback = h("div", {});

  // Two clicks to wipe everything: the first one only arms the button.
  const wipe = h("button", { class: "danger", text: "Hapus semua" });
  let armed: number | null = null;

  function render(facts: Fact[]) {
    clear(list);
    // Nothing to show until Miu has learned something.
    count.textContent = `${facts.length} fakta tersimpan.`;
    for (const el of [count, list, wipe]) el.hidden = facts.length === 0;
    for (const f of [...facts].reverse()) {
      const del = h("button", { class: "danger", title: "Lupakan fakta ini", text: "✕" });
      del.addEventListener("click", async () => {
        clear(feedback);
        try {
          await Bridge.memoryForget(f.id);
        } catch (err) {
          feedback.append(notice("err", errText(err)));
        }
      });
      list.append(
        h(
          "li",
          {},
          h(
            "span",
            { class: "fact-text" },
            h("span", { text: f.text }),
            h("span", { class: "fact-meta", text: `${f.kind} · ${f.date} · ${SOURCE_LABEL[f.source] ?? f.source}` }),
          ),
          del,
        ),
      );
    }
  }

  reloadFacts = async () => render((await Bridge.memoryList()) ?? []);

  wipe.addEventListener("click", async () => {
    clear(feedback);
    if (armed == null) {
      wipe.textContent = "Yakin? Klik lagi";
      armed = window.setTimeout(() => {
        armed = null;
        wipe.textContent = "Hapus semua";
      }, 4000);
      return;
    }
    window.clearTimeout(armed);
    armed = null;
    wipe.textContent = "Hapus semua";
    try {
      await Bridge.memoryClear();
      feedback.append(notice("ok", "Semua ingatan dihapus."));
    } catch (err) {
      feedback.append(notice("err", errText(err)));
    }
  });

  const memoryRows = [
    h("div", { class: "row" },
      h("label", { text: "Ringkas otomatis" }),
      toggle(settings.autoSummary, (v) => { settings.autoSummary = v; void save(); }),
      h("span", { class: "hint", text: "Hal penting dari chat disimpan sendiri." }),
    ),
    count,
    list,
    wipe,
  ];
  const showRows = () => {
    for (const row of memoryRows) row.style.display = settings.memoryEnabled ? "" : "none";
  };

  void reloadFacts();
  showRows();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Ingatan" })),
    h("div", { class: "row" },
      h("label", { text: "Ingat tentang aku" }),
      toggle(settings.memoryEnabled, (v) => { settings.memoryEnabled = v; showRows(); void save(); }),
      h("span", { class: "hint", text: "Miu boleh menyimpan dan memakai fakta tentangmu." }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Simpan percakapan" }),
      toggle(settings.keepChat, (v) => { settings.keepChat = v; void save(); }),
      h("span", { class: "hint", text: "Chat terakhir muncul lagi setelah restart atau shutdown." }),
    ),
    ...memoryRows,
    feedback,
  );
}

/** Where dropped files are copied: the default folder or one the user picks. */
function filesSection(): HTMLElement {
  const path = h("span", { class: "path", text: dropRoot });
  const change = h("button", { text: "Ganti folder…" });
  const reset = h("button", { text: "Kembalikan default" });
  const feedback = h("div", {});

  function refresh() {
    path.textContent = dropRoot;
    reset.style.display = settings.dropRoot ? "" : "none";
  }

  async function apply(root: string, message: string) {
    clear(feedback);
    settings.dropRoot = root;
    await save();
    dropRoot = (await Bridge.filesRoot()) ?? root;
    refresh();
    feedback.append(notice("ok", message));
  }

  change.addEventListener("click", async () => {
    change.setAttribute("disabled", "");
    try {
      const picked = await Bridge.pickDropFolder();
      if (picked) await apply(picked, "Folder diganti. File berikutnya disalin ke sini.");
    } finally {
      change.removeAttribute("disabled");
    }
  });
  reset.addEventListener("click", () => void apply("", "Kembali ke folder default."));

  refresh();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Folder penampungan file" })),
    h("div", { class: "row" }, path),
    h("div", { class: "row" }, change, reset),
    h("div", {
      class: "hint",
      text: "File yang dijatuhkan ke karakter disalin ke sini, ke subfolder Documents, Images, Data, Archive, atau Inbox. " +
        "File asli tidak diubah, dan file yang sudah ada tidak pernah ditimpa. Mengganti folder tidak memindahkan file lama.",
    }),
    feedback,
  );
}

function aboutSection(): HTMLElement {
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Tentang build ini" })),
    h("div", {
      class: "notice",
      text: "Miu Lite memakai karakter Miu v0.4 dan nada sintetis. Kode turunan MIT beserta kreditnya disertakan dalam LICENSE. Setelan, log, dan file lokal disimpan di MiuLite-data di samping exe.",
    }),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
    dropRoot = boot.dropRoot;
  }

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Miu Lite" }), h("span", { class: "version", text: version })),
    llmSection(() => settings, save),
    memorySection(),
    generalSection(),
    filesSection(),
    aboutSection(),
    h("div", {
      class: "hint",
      text: "Tanpa telemetri. Chat dan ringkasan menggunakan penyedia pilihanmu; pencarian web memakai layanan penyedia atau Ollama Web Search.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    Object.assign(settings, s);
  });
  // Gemini saved or forgot a fact, a summary added some, or a click here.
  void onEvent<null>("memory-changed", () => void reloadFacts());
}

void main();
