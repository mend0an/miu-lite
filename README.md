# Miu Lite 0.1.0

Teman desktop portable untuk Windows 11, dengan karakter kucing Miu v0.4 dan chat Google Gemini.

![Miu](public/miu-rig/assets/icon_256.png)

## Unduh dan jalankan

Unduh ZIP portable dari [Releases](https://github.com/mend0an/miu-lite/releases), ekstrak ke folder yang dapat ditulis, lalu jalankan `MiuLite-0.1.0-portable.exe`. Windows memerlukan Microsoft Edge WebView2 Runtime. Build ini belum ditandatangani secara digital.

Klik kanan Miu → **Pengaturan**. Masukkan API key Gemini milikmu, muat daftar model, pilih model, lalu tes koneksi. Pemakaian API mengikuti kuota dan tarif penyedia akunmu. Jangan membagikan API key.

- Klik tombol gelembung untuk membuka chat. Seret Miu untuk memindahkannya.
- `Ctrl+Alt+D` menampilkan atau menyembunyikan widget. Menu tray juga menyediakan pengaturan dan keluar.
- Ingatan dan percakapan disimpan lokal, dengan pilihan untuk menonaktifkan atau menghapusnya.
- File yang dijatuhkan ke Miu disalin setelah konfirmasi, diperiksa dengan SHA-256, dan tidak menimpa file yang sudah ada.
- Miu dapat bergoyang saat Spotify memutar musik. Gerakan dan nada sintetis dapat dimatikan di pengaturan.

## Data dan koneksi

Setelan, percakapan, ingatan, log, dan folder penampungan file berada di `MiuLite-data` di samping executable. Jika folder tersebut tidak dapat ditulis, aplikasi memakai folder `MiuLite` di AppData. API key disimpan terpisah di Windows Credential Manager dengan layanan `miu-lite`. Memindahkan aplikasi ke PC lain tidak membawa API key.

Chat dan konteks ingatan yang diaktifkan dikirim ke endpoint Gemini yang dipilih pengguna. Ringkasan otomatis memakai satu panggilan Gemini tambahan setelah percakapan. Tidak ada telemetri. File yang dijatuhkan disalin lokal; isi file tidak otomatis diunggah ke Gemini.

## Build dari source

Prasyarat: Windows 11, Node.js/npm, Rust stable, Visual Studio C++ Build Tools dan Windows SDK, serta WebView2 Runtime.

```powershell
npm ci
npm run build
cargo test --locked
npm run pack
```

Hasil: `release/MiuLite-0.1.0-portable.exe`. `npm run icons` membuat ulang ikon dari layer kepala Miu. Untuk pengembangan gunakan `npm run tauri dev`; halaman browser saja tidak menyediakan layanan native.

Pemeriksaan paket: `npm run check:release`. Pengujian renderer: jalankan `npm run dev`, lalu buka `http://127.0.0.1:1420/dev/miu-check.html`; hasil harus `PASS`. Pengujian nada: `/dev/sound-check.html`, lalu tekan **Uji suara**.

## Lisensi dan kredit

Kode berlisensi MIT; lihat [LICENSE](LICENSE) dan [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Kode turunan dari Coucou karya Louis Raillé tetap menyertakan pemberitahuan MIT aslinya. Miu Lite adalah proyek terpisah dan tidak menyiratkan dukungan dari penulis upstream.

Artwork Miu dan ikon turunannya memiliki ketentuan terpisah di [LICENSE-ASSETS.md](LICENSE-ASSETS.md). Suara aplikasi berupa nada osilator yang dibuat dalam kode; tidak ada rekaman audio pihak lain di paket ini. Hak atas dependensi tetap mengikuti lisensi masing-masing.
