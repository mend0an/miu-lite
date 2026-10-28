import { Bridge, type ModelInfo } from "../core/bridge";
import { PROVIDERS, type ProviderId, type Settings } from "../core/state";
import { h, clear } from "../views/dom";

export function llmSection(get: () => Settings, save: () => Promise<void>): HTMLElement {
  const section = h("section");
  let generation = 0;

  async function render() {
    const token = ++generation;
    const s = get();
    const kind = s.provider;
    const info = PROVIDERS[kind];
    const hasKey = (await Bridge.secretPresent(info.key)) ?? false;
    const hasSearchKey = (await Bridge.secretPresent("ollama-search-key")) ?? false;
    if (token !== generation) return;
    clear(section);
    const feedback = h("div", { role: "status", "aria-live": "polite" });
    const provider = h("select", { id: "llm-provider" });
    for (const [id, p] of Object.entries(PROVIDERS)) provider.append(h("option", { value: id, text: p.label }));
    provider.value = kind;
    const key = h("input", { id: "llm-key", type: "password", autocomplete: "off", placeholder: hasKey ? "Tersimpan di Credential Manager" : kind === "ollama" ? "Opsional untuk server berautentikasi" : "API key penyedia" });
    const model = h("select", { id: "llm-model" });
    const manual = h("input", { id: "llm-manual", placeholder: kind === "ollama" ? "mis. qwen3:4b" : "ID model", autocomplete: "off" });
    const base = h("input", { id: "llm-url", type: "url", value: s.llmBaseUrl || info.base, spellcheck: "false" });
    const web = h("select", { id: "llm-web" }, h("option", { value: "auto", text: "Otomatis" }), h("option", { value: "off", text: "Mati" }));
    web.value = s.webSearch ? "auto" : "off";
    const searchKey = h("input", { id: "llm-search-key", type: "password", autocomplete: "off", placeholder: hasSearchKey ? "Key pencarian tersimpan" : "API key dari ollama.com/settings/keys" });
    let busy = false;
    async function run(action: () => Promise<void>) {
      if (busy) return;
      busy = true;
      const controls = [...section.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")];
      controls.forEach(c => c.disabled = true);
      feedback.textContent = "Memproses…";
      try { await action(); }
      catch (err) { feedback.textContent = String(err).replace(/^Error:\s*/, ""); }
      finally { busy = false; controls.forEach(c => c.disabled = false); }
    }
    function row(label: string, control: HTMLElement, ...buttons: HTMLElement[]) {
      return h("div", { class: "row" }, h("label", { for: control.id, text: label }), control, ...buttons);
    }
    function button(text: string, action: () => Promise<void>) {
      return h("button", { type: "button", text, onclick: () => void run(action) });
    }
    function fill(models: ModelInfo[]) {
      clear(model);
      model.append(h("option", { value: "", text: "Pilih model" }));
      for (const m of models) model.append(h("option", { value: m.id, text: m.displayName === m.id ? m.id : `${m.displayName} (${m.id})` }));
      if (s.model && !models.some(m => m.id === s.model)) model.append(h("option", { value: s.model, text: `${s.model} (tersimpan)` }));
      model.value = s.model;
    }
    async function selectModel(id: string) {
      if (!id || id.length > 200 || /\s/.test(id)) throw new Error("ID model tidak valid.");
      s.model = kind === "gemini" ? id.replace(/^models\//, "") : id;
      await save();
      fill([]);
      feedback.textContent = `Model disimpan: ${s.model}. Gunakan Tes koneksi untuk memeriksa.`;
    }
    provider.addEventListener("change", () => void run(async () => {
      s.providerProfiles = { ...s.providerProfiles, [kind]: { model: s.model, baseUrl: s.llmBaseUrl } };
      const next = provider.value as ProviderId;
      s.provider = next;
      s.model = s.providerProfiles[next]?.model || "";
      s.llmBaseUrl = s.providerProfiles[next]?.baseUrl || "";
      await save();
      await render();
    }));
    model.addEventListener("change", () => { if (model.value) void run(() => selectModel(model.value)); });
    web.addEventListener("change", () => void run(async () => { s.webSearch = web.value === "auto"; await save(); feedback.textContent = s.webSearch ? "Pencarian otomatis aktif." : "Pencarian web dimatikan."; }));
    section.append(
      h("h2", { text: "Model dan pencarian" }),
      row("Penyedia", provider),
      row("API key", key,
        button("Simpan key", async () => {
          if (!key.value.trim()) throw new Error("Isi key terlebih dahulu.");
          await Bridge.secretSet(info.key, key.value.trim()); key.value = "";
          await save(); await render();
        }),
        button("Hapus key", async () => { await Bridge.secretClear(info.key); await save(); await render(); })),
      row("URL API", base, button("Simpan URL", async () => {
        const url = await Bridge.llmCheckUrl(base.value.trim() || info.base);
        s.llmBaseUrl = url === info.base ? "" : url;
        await save(); feedback.textContent = "URL API disimpan.";
      })),
      row("Model", model, button("Muat daftar", async () => { fill((await Bridge.llmModels()) || []); feedback.textContent = model.options.length > 1 ? "Daftar model dimuat." : "Tidak ada model. Isi ID manual atau pasang model di Ollama."; })),
      row("ID manual", manual, button("Pakai", async () => { await selectModel(manual.value.trim()); manual.value = ""; })),
      button("Tes koneksi", async () => { feedback.textContent = (await Bridge.llmTest()) || "Tidak ada respons dari aplikasi."; }),
      row("Pencarian web", web),
      h("div", { class: "hint", text: kind === "ollama"
        ? "Model dijalankan oleh Ollama di komputer/server pilihanmu. Pasang dan jalankan Ollama serta unduh model terlebih dahulu. Chat tidak memerlukan internet; pencarian otomatis mengirim permintaan ke Ollama Web Search."
        : "Pencarian dijalankan otomatis saat diperlukan, memakai layanan bawaan penyedia. Dukungan dan biaya mengikuti model serta akun API. Key disimpan di Windows Credential Manager." }),
    );
    if (kind === "ollama") section.append(row("Key pencarian", searchKey,
      button("Simpan", async () => { if (!searchKey.value.trim()) throw new Error("Isi key pencarian."); await Bridge.secretSet("ollama-search-key", searchKey.value.trim()); searchKey.value = ""; await render(); }),
      button("Hapus", async () => { await Bridge.secretClear("ollama-search-key"); await render(); })),
      h("div", { class: "hint", text: "Key pencarian berbeda dari key server lokal. Tanpa key pencarian, matikan pencarian web untuk chat offline." }));
    section.append(h("div", { class: "hint", text: "Chat dan ingatan yang aktif dikirim ke penyedia/model pilihanmu. Ringkasan memakai model yang sama. Mengganti penyedia mempertahankan percakapan saat ini; mulai percakapan baru jika ingin konteks kosong." }), feedback);
    fill([]);
  }
  void render();
  return section;
}
