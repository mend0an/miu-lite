# Miu Lite 0.1.0

A portable Windows 11 desktop companion featuring Miu v0.4 and Google Gemini chat.

![Miu](public/miu-rig/assets/icon_256.png)

## Download and run

1. Download [MiuLite-0.1.0-portable.zip](https://github.com/mend0an/miu-lite/releases/download/v0.1.0/MiuLite-0.1.0-portable.zip).
2. Extract the ZIP into a writable folder. It contains the executable and license notices.
3. Run **MiuLite-0.1.0-portable.exe** from the extracted folder.

The app requires Microsoft Edge WebView2 Runtime. This build is not digitally signed. You can verify the ZIP using [SHA256SUMS.txt](https://github.com/mend0an/miu-lite/releases/download/v0.1.0/SHA256SUMS.txt).

Right-click Miu and open **Pengaturan** (Settings). Enter your Gemini API key, load and select a model, then test the connection. API usage is subject to your provider's account limits and pricing. Keep your API key private.

- Click the speech bubble to open chat, or drag Miu around your screen.
- Press `Ctrl+Alt+D` to show or hide the widget. The system tray menu also provides settings and an exit option.
- Memories and conversations are stored locally and can be disabled or deleted.
- Files dropped onto Miu are copied after confirmation, verified with SHA-256, and never overwrite existing files.
- Miu can dance while Spotify is playing. Animation and synthesized sounds can be disabled in settings.

## Technology

The desktop backend is written in **Rust** with **Tauri**. The interface and Miu's layered renderer use **TypeScript**, **HTML**, and **CSS**, built with **Vite**. Python scripts were used to prepare Miu's layered artwork.

## Data and connections

Settings, conversations, memories, logs, and dropped files are stored in `MiuLite-data` next to the executable. If that folder is not writable, the app uses a `MiuLite` folder in AppData. The API key is stored separately in Windows Credential Manager under the `miu-lite` service and does not move with the app to another PC.

Chat and enabled memory context are sent to the user-selected Gemini endpoint. Automatic summaries use one additional Gemini request after a conversation. There is no telemetry. Dropped files are copied locally; their contents are not automatically uploaded to Gemini.

## Build from source

Requirements: Windows 11, Node.js/npm, stable Rust, Visual Studio C++ Build Tools and Windows SDK, and WebView2 Runtime.

```powershell
npm ci
npm run build
cargo test --locked
npm run pack
```

The executable is written to `release/MiuLite-0.1.0-portable.exe`; the portable ZIP and checksum are created in the same folder. `npm run icons` regenerates the icons from Miu's head layers. Use `npm run tauri dev` for development; the browser-only page does not provide native services.

Run `npm run check:release` to check the package. To test the renderer, run `npm run dev` and open `http://127.0.0.1:1420/dev/miu-check.html`; the result should be `PASS`. To test the synthesized sounds, open `/dev/sound-check.html` and click **Uji suara**.

## License and credits

The code is licensed under MIT; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Code derived from Coucou by Louis Raillé retains its original MIT notice. Miu Lite is a separate project and does not imply endorsement by the upstream author.

The Miu artwork and derived icons have separate terms in [LICENSE-ASSETS.md](LICENSE-ASSETS.md). Application sounds are oscillator tones generated in code; no third-party audio recordings are bundled. Dependencies retain their respective licenses.
