import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = name => readFileSync(join(root, name), "utf8");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const config = JSON.parse(read("src-tauri/tauri.conf.json"));
assert.equal(pkg.version, "0.1.1");
assert.equal(lock.packages[""].version, pkg.version);
assert.equal(config.version, pkg.version);
assert.equal(config.identifier, "com.miu.lite");
assert.match(read("Cargo.toml"), /version = "0\.1\.1"/);
const restricted = new RegExp(["ha" + "ro", "mo" + "chi", "gun" + "dam", "notch" + "buddy"].join("|"), "i");
const texts = new Set(["ts", "rs", "html", "css", "mjs", "json", "toml", "ps1"]);
let files = 0;
function scan(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (["node_modules", "target", "release", ".git", "gen"].includes(entry.name)) continue;
    const path = join(folder, entry.name);
    assert(!restricted.test(entry.name), `Restricted filename: ${path}`);
    assert(!/\.(wav|mp3|ogg|mp4|gif)$/i.test(entry.name), `Unexpected media: ${path}`);
    assert(!/^\.env(?:\.|$)|^(settings|memory|chat)\.json$|\.log$/i.test(entry.name), `Personal data: ${path}`);
    if (entry.isDirectory()) scan(path);
    else {
      files++;
      if (texts.has(entry.name.split(".").pop())) {
        assert(!restricted.test(readFileSync(path, "utf8")), `Restricted reference: ${path}`);
      }
    }
  }
}
scan(root);
assert(existsSync(join(root, "dist/index.html")), "Build the frontend first");
assert(!existsSync(join(root, "dist/sounds")), "Recorded sound assets must not ship");
for (const name of ["LICENSE", "LICENSE-ASSETS.md", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.txt"]) {
  assert(existsSync(join(root, name)), `Missing notice: ${name}`);
}
console.log(`PASS: ${files} source/build files; Miu only; version ${pkg.version}; no recorded audio or personal data.`);
