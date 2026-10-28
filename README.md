# Miu Lite 0.1.1

A portable Windows 11 desktop companion featuring Miu v0.4, selectable AI providers, and automatic web search.

![Miu](public/miu-rig/assets/icon_256.png)

## New in 0.1.1

- Select Google Gemini, OpenAI / GPT, Anthropic / Claude, or a local model through Ollama.
- Keep a separate model, API URL, and credential for each provider.
- Search the web automatically when a question needs current information, with clickable sources. Set search to **Mati** for offline chat with a local Ollama server.
- Keep existing Gemini settings, local memories, and conversation history when upgrading from 0.1.0.

## Download and run

1. Download [MiuLite-0.1.1-portable.zip](https://github.com/mend0an/miu-lite/releases/download/v0.1.1/MiuLite-0.1.1-portable.zip).
2. Extract the ZIP into a writable folder. It contains the executable and license notices.
3. Run **MiuLite-0.1.1-portable.exe** from the extracted folder.

The app requires Microsoft Edge WebView2 Runtime. This build is not digitally signed. You can verify the ZIP using [SHA256SUMS.txt](https://github.com/mend0an/miu-lite/releases/download/v0.1.1/SHA256SUMS.txt).

To upgrade from 0.1.0, quit the old app from its tray menu, then extract 0.1.1 into the same writable folder and run the new EXE. Keep the existing `MiuLite-data` folder to retain settings, memories, and chat. If you move to a different folder, copy that data folder too. Credentials remain in Windows Credential Manager on the same PC.

Right-click Miu and open **Pengaturan** (Settings). Select a provider, enter its API key, load or enter a model, then test the connection. Ollama uses `http://127.0.0.1:11434` by default and does not require a key for a local server. Install Ollama and download a model separately. API usage is subject to your provider's account limits and pricing. Keep your API keys private.

Set **Pencarian web** to **Otomatis** or **Mati**. No search button is needed: explicit search requests and a decision by the selected model determine whether to search. An instruction such as "tanpa internet" disables search for that message. Gemini uses Google Search; GPT and Claude use their own hosted search tools. A model or account that cannot use search reports an error without switching providers. Search can incur additional API charges.

For local models, automatic search uses the separate Ollama Web Search service. Configure its key from `ollama.com/settings/keys` in **Key pencarian**. Search sends the latest query to that service, while inference stays on the selected Ollama server. For offline chat, set web search to **Mati**. Local models without tool support can still chat and use automatic memory summaries, but cannot directly invoke save/forget tools.

Sources returned by the search service are appended as clickable links. Google search suggestions are displayed in an isolated frame and retained with the saved answer. If the provider returns no sources, Miu labels the answer as unverified. Search decisions may require an additional request to the selected model; that request can add latency and token usage.

- Click the speech bubble to open chat, or drag Miu around your screen.
- Press `Ctrl+Alt+D` to show or hide the widget. The system tray menu also provides settings and an exit option.
- Memories and conversations are stored locally and can be disabled or deleted.
- Files dropped onto Miu are copied after confirmation, verified with SHA-256, and never overwrite existing files.
- Miu can dance while Spotify is playing. Animation and synthesized sounds can be disabled in settings.

## Technology

The desktop backend is written in **Rust** with **Tauri**. The interface and Miu's layered renderer use **TypeScript**, **HTML**, and **CSS**, built with **Vite**. Python scripts were used to prepare Miu's layered artwork.

## Data and connections

Settings, conversations, memories, logs, and dropped files are stored in `MiuLite-data` next to the executable. If that folder is not writable, the app uses a `MiuLite` folder in AppData. API keys are stored separately in Windows Credential Manager under the `miu-lite` service and do not move with the app to another PC.

Chat, enabled memory context, and automatic summaries are sent to the selected provider endpoint. Changing provider preserves the current conversation; start a new conversation to clear that context. Existing Gemini settings and its stored key remain usable after upgrading. Each provider retains its own model, URL and key. Web search uses the provider's hosted service, or Ollama Web Search for local models. There is no telemetry. Dropped files are copied locally; their contents are not automatically uploaded.

## Build from source

Requirements: Windows 11, Node.js/npm, stable Rust, Visual Studio C++ Build Tools and Windows SDK, and WebView2 Runtime.

```powershell
npm ci
npm run build
cargo test --locked
npm run pack
```

The executable is written to `release/MiuLite-0.1.1-portable.exe`; the portable ZIP and checksum are created in the same folder. `npm run icons` regenerates the icons from Miu's head layers. Use `npm run tauri dev` for development; the browser-only page does not provide native services.

Run `npm run check:release` to check the package. To test the renderer, run `npm run dev` and open `http://127.0.0.1:1420/dev/miu-check.html`; the result should be `PASS`. To test the synthesized sounds, open `/dev/sound-check.html` and click **Uji suara**.

## Validation

The 0.1.1 release passed the TypeScript/Vite build, 17 Rust tests, and the public package checks. Provider request formats are tested against local HTTP fixtures. Browser checks cover provider switching, saved model choices, and the search settings. Live provider coverage is incomplete; model access, search support, and quota must be checked with your own account. Native Windows startup was checked, while the interactive chat/Stop check was interrupted by the test capture tool.

## License and credits

The code is licensed under MIT; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Code derived from Coucou by Louis Raillé retains its original MIT notice. Miu Lite is a separate project and does not imply endorsement by the upstream author.

The Miu artwork and derived icons have separate terms in [LICENSE-ASSETS.md](LICENSE-ASSETS.md). Application sounds are oscillator tones generated in code; no third-party audio recordings are bundled. Dependencies retain their respective licenses.
