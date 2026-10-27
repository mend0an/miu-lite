// Package the Windows portable executable.

import { readFileSync, mkdirSync, copyFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(process.env.CARGO_TARGET_DIR || join(root, "target"), "release", "miu-lite.exe");
const outDir = join(root, "release");

const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

if (!existsSync(built)) {
  console.error(`No ${built} — run \`npm run tauri build\` first.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const dest = join(outDir, `MiuLite-${version}-portable.exe`);
copyFileSync(built, dest);

const mb = (statSync(dest).size / 1024 / 1024).toFixed(2);
console.log(`\n  Portable exe ready\n\n  ${dest}  (${mb} MB)\n`);
execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts/package-release.ps1")], { stdio: "inherit" });
