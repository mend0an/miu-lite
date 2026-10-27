// Settings window: the Gemini key and model, the character and general
// preferences, and the drop folder. The key is write-only from here: the page
// can store or remove it, and ask whether it exists, but never read it back.

import "./settings.css";
import { Bridge, GEMINI_KEY, onEvent, type Fact, type ModelInfo } from "../core/bridge";
import { DEFAULT_SETTINGS, GEMINI_DEFAULT_BASE, type Settings } from "../core/state";
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

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function notice(kind: "ok" | "err" | "warn", text: string): HTMLElement {
  return h("div", { class: `notice ${kind}`, text });
}

// ── Gemini ────────────────────────────────────────────────────────────────────

function geminiSection(hasKeyAtStart: boolean): HTMLElement {
  let models: ModelInfo[] = [];
  let hasKey = hasKeyAtStart;

  const dot = statusDot(false);
  const state = h("div", { class: "hint" });

  const keyField = h("input", {
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const saveKey = h("button", { class: "primary", text: "Simpan key" });
  const clearKey = h("button", { class: "danger", text: "Hapus" });

  const modelSelect = h("select", { style: "flex:1 1 auto;min-width:0" }) as HTMLSelectElement;
  const reload = h("button", { text: "Muat daftar" });
  const manual = h("input", {
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "mis. gemini-3.6-flash",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const useManual = h("button", { text: "Pakai" });

  const baseUrl = h("input", {
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: GEMINI_DEFAULT_BASE,
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const saveUrl = h("button", { text: "Simpan URL" });

  const testBtn = h("button", { class: "primary", text: "Tes koneksi" });
  const feedback = h("div", {});

  function ready(): boolean {
    return hasKey && !!settings.model;
  }

  function refresh() {
    keyField.placeholder = hasKey ? "••••••••••••  (tersimpan)" : "Tempel API key Gemini";
    clearKey.style.display = hasKey ? "" : "none";
    baseUrl.value = settings.llmBaseUrl || GEMINI_DEFAULT_BASE;
    dot.style.background = ready() ? "#22c55e" : "#f4505e";
    state.textContent = ready()
      ? `Aktif: Google Gemini · model ${settings.model}.`
      : !hasKey
        ? "Isi API key Gemini, lalu pilih model."
        : "Pilih model.";
    testBtn.toggleAttribute("disabled", !ready());
  }

  function fillSelect() {
    clear(modelSelect);
    modelSelect.append(h("option", { value: "", text: models.length ? "— pilih model —" : "— muat daftar dulu —" }));
    const featured = models.filter((m) => m.featured);
    const rest = models.filter((m) => !m.featured);
    const group = (label: string, list: ModelInfo[]) => {
      if (!list.length) return;
      const g = h("optgroup", { label });
      for (const m of list) {
        g.append(h("option", { value: m.id, text: m.displayName === m.id ? m.id : `${m.displayName} (${m.id})` }));
      }
      modelSelect.append(g);
    };
    if (featured.length) {
      group("Flash", featured);
      group("Model lain", rest);
    } else {
      group("Model", rest);
    }
    if (settings.model && !models.some((m) => m.id === settings.model)) {
      modelSelect.append(h("option", { value: settings.model, text: `${settings.model} (manual)` }));
    }
    modelSelect.value = settings.model;
  }

  async function loadModels() {
    clear(feedback);
    reload.setAttribute("disabled", "");
    reload.textContent = "Memuat…";
    try {
      models = await Bridge.llmModels();
      fillSelect();
      if (!models.length) feedback.append(notice("warn", "Gemini tidak memberi daftar model. Ketik ID model di bawah."));
    } catch (err) {
      models = [];
      fillSelect();
      feedback.append(notice("err", errText(err)));
    } finally {
      reload.removeAttribute("disabled");
      reload.textContent = "Muat daftar";
      refresh();
    }
  }

  async function setModel(id: string) {
    settings.model = id;
    await save();
    fillSelect();
    refresh();
  }

  saveKey.addEventListener("click", async () => {
    const value = keyField.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet(GEMINI_KEY, value);
      keyField.value = "";
      hasKey = (await Bridge.secretPresent(GEMINI_KEY)) ?? false;
      feedback.append(notice("ok", "Key disimpan di Windows Credential Manager."));
      refresh();
      // Tells the widget a key now exists (it re-checks on settings-changed).
      await save();
      await loadModels();
    } catch (err) {
      feedback.append(notice("err", `Gagal menyimpan: ${errText(err)}`));
    }
  });

  clearKey.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear(GEMINI_KEY);
      hasKey = false;
      feedback.append(notice("ok", "Key dihapus."));
      refresh();
      await save();
    } catch (err) {
      feedback.append(notice("err", `Gagal menghapus: ${errText(err)}`));
    }
  });

  modelSelect.addEventListener("change", () => {
    if (modelSelect.value) void setModel(modelSelect.value);
  });

  useManual.addEventListener("click", () => {
    const id = manual.value.trim().replace(/^models\//, "");
    clear(feedback);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) {
      feedback.append(notice("err", "ID model tidak valid."));
      return;
    }
    manual.value = "";
    void setModel(id).then(() => feedback.append(notice("ok", `Model diganti ke ${id}. Tekan Tes koneksi untuk memastikan.`)));
  });

  saveUrl.addEventListener("click", async () => {
    clear(feedback);
    const raw = baseUrl.value.trim();
    try {
      settings.llmBaseUrl = !raw || raw === GEMINI_DEFAULT_BASE ? "" : await Bridge.llmCheckUrl(raw);
      await save();
      feedback.append(notice("ok", "URL disimpan."));
      refresh();
      if (hasKey) await loadModels();
    } catch (err) {
      feedback.append(notice("err", errText(err)));
    }
  });

  reload.addEventListener("click", () => void loadModels());

  testBtn.addEventListener("click", async () => {
    clear(feedback);
    testBtn.setAttribute("disabled", "");
    testBtn.textContent = "Menguji…";
    try {
      feedback.append(notice("ok", await Bridge.llmTest()));
    } catch (err) {
      feedback.append(notice("err", errText(err)));
    } finally {
      testBtn.textContent = "Tes koneksi";
      refresh();
    }
  });

  fillSelect();
  refresh();
  if (hasKey) void loadModels();

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Google Gemini" })),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), keyField, saveKey, clearKey),
    h("div", { class: "row" }, h("label", { text: "Model" }), modelSelect, reload),
    h("div", { class: "row" }, h("label", { text: "ID manual" }), manual, useManual),
    h("div", { class: "row" }, h("label", { text: "URL API" }), baseUrl, saveUrl),
    h("div", { class: "row" }, h("label", { text: "" }), testBtn),
    h("div", {
      class: "hint",
      text: "API key gratis dari aistudio.google.com. Key disimpan di Windows Credential Manager PC ini, " +
        "jadi di PC lain perlu diisi lagi. URL API biarkan default kecuali memakai proxy.",
    }),
    feedback,
  );
}

// ── Character and general ─────────────────────────────────────────────────────

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
  const hasKey = (await Bridge.secretPresent(GEMINI_KEY)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Miu Lite" }), h("span", { class: "version", text: version })),
    geminiSection(hasKey),
    memorySection(),
    generalSection(),
    filesSection(),
    aboutSection(),
    h("div", {
      class: "hint",
      text: "Tanpa telemetri. Permintaan jaringan hanya ke Google Gemini (chat dan ringkasan ingatan).",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
  // Gemini saved or forgot a fact, a summary added some, or a click here.
  void onEvent<null>("memory-changed", () => void reloadFacts());
}

void main();
