// File drop (PRD 1.2 §6): dropped files are *copied* into rule-based folders
// under %USERPROFILE%\Miu, or under the folder the user picked
// in the settings (`dropRoot`). The source is never touched, an
// existing file is never overwritten, and nothing here is ever deleted
// automatically — Coucou's 7-day inbox sweep was removed on purpose.
//
// Two steps, so the user sees where everything goes before anything is written:
// `plan` only reads metadata; `copy` does the work and verifies every copy.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::Serialize;

use crate::platform;

/// The default folder inside the portable data folder.
const PORTABLE_ROOT_NAME: &str = "Files";
/// The default folder under %USERPROFILE% when the exe folder is read-only.
const HOME_ROOT_NAME: &str = "Miu Lite";

/// The folder picked in the settings; None = the default.
static CUSTOM_ROOT: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Extension rules, checked in order. Matching ignores case.
const RULES: &[(&str, &[&str])] = &[
    ("Documents", &["pdf", "docx", "txt"]),
    ("Images", &["jpg", "jpeg", "png", "webp"]),
    ("Data", &["xlsx", "xls", "csv"]),
    ("Archive", &["zip", "7z"]),
];
const FALLBACK: &str = "Inbox";

pub fn default_root() -> PathBuf {
    match platform::portable_dir() {
        Some(dir) => dir.join(PORTABLE_ROOT_NAME),
        None => platform::home_dir().join(HOME_ROOT_NAME),
    }
}

/// Follows the `dropRoot` setting. Anything but an absolute path (empty
/// included) means the default folder.
pub fn set_root(custom: &str) {
    let custom = custom.trim();
    let path = PathBuf::from(custom);
    let root = (!custom.is_empty() && path.is_absolute()).then_some(path);
    *CUSTOM_ROOT.write().unwrap() = root;
}

pub fn root_dir() -> PathBuf {
    CUSTOM_ROOT.read().unwrap().clone().unwrap_or_else(default_root)
}

fn folder_for(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    RULES
        .iter()
        .find(|(_, exts)| exts.contains(&ext.as_str()))
        .map(|(folder, _)| *folder)
        .unwrap_or(FALLBACK)
}

/// "report.pdf" → "report (2).pdf" → "report (3).pdf" … skipping names that
/// exist on disk or are already taken by an earlier file in the same batch.
fn free_name(dir: &Path, name: &str, taken: &HashSet<PathBuf>) -> Option<String> {
    let free = |n: &str| {
        let p = dir.join(n);
        !p.exists() && !taken.contains(&p)
    };
    if free(name) {
        return Some(name.to_string());
    }
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..10_000).map(|i| format!("{stem} ({i}){ext}")).find(|n| free(n))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub source: String,
    pub name: String,
    pub size: u64,
    pub folder: String,
    pub dest_name: String,
    pub dest_path: String,
    /// The original name was taken; the copy gets `dest_name` instead.
    pub renamed: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub root: String,
    pub root_exists: bool,
    pub items: Vec<PlanItem>,
}

pub fn plan(paths: &[String]) -> Plan {
    let root = root_dir();
    let mut taken = HashSet::new();
    let items = paths
        .iter()
        .map(|source| {
            let name = Path::new(source)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into());
            let folder = folder_for(&name).to_string();
            let mut item = PlanItem {
                source: source.clone(),
                name: name.clone(),
                size: 0,
                folder: folder.clone(),
                dest_name: name.clone(),
                dest_path: String::new(),
                renamed: false,
                error: None,
            };
            match std::fs::metadata(source) {
                Err(e) => item.error = Some(format!("Tidak bisa dibaca: {e}")),
                Ok(m) if m.is_dir() => item.error = Some("Folder belum bisa disalin.".into()),
                Ok(m) => {
                    item.size = m.len();
                    let dir = root.join(&folder);
                    match free_name(&dir, &name, &taken) {
                        Some(dest) => {
                            let path = dir.join(&dest);
                            taken.insert(path.clone());
                            item.renamed = dest != name;
                            item.dest_name = dest;
                            item.dest_path = path.to_string_lossy().to_string();
                        }
                        None => item.error = Some("Tidak menemukan nama tujuan yang kosong.".into()),
                    }
                }
            }
            item
        })
        .collect();
    Plan {
        root: root.to_string_lossy().to_string(),
        root_exists: root.is_dir(),
        items,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub source: String,
    pub name: String,
    pub folder: String,
    pub dest_path: Option<String>,
    pub size: u64,
    pub renamed: bool,
    pub ok: bool,
    pub error: Option<String>,
}

/// Copies every file of the batch, one by one, and reports each separately: a
/// failure never stops the rest, and never leaves a half-written file behind.
pub fn copy(paths: &[String]) -> Vec<CopyResult> {
    // Planned again here: names may have been taken since the preview.
    let plan = plan(paths);
    let root = PathBuf::from(&plan.root);
    let mut taken = HashSet::new();
    plan.items
        .into_iter()
        .map(|item| {
            let mut result = CopyResult {
                source: item.source.clone(),
                name: item.name.clone(),
                folder: item.folder.clone(),
                dest_path: None,
                size: item.size,
                renamed: item.renamed,
                ok: false,
                error: item.error.clone(),
            };
            if item.error.is_some() {
                return result;
            }
            let dir = root.join(&item.folder);
            match copy_one(Path::new(&item.source), &dir, &item.name, item.size, &mut taken) {
                Ok(dest) => {
                    result.renamed = dest.file_name().map(|n| n.to_string_lossy() != item.name).unwrap_or(false);
                    result.dest_path = Some(dest.to_string_lossy().to_string());
                    result.ok = true;
                    // Activity log (PRD §6): destination and size, never content.
                    crate::log::line(format!("copy ok -> {} ({} bytes)", dest.display(), item.size));
                }
                Err(e) => {
                    crate::log::line(format!("copy failed -> {}\\{}: {e}", item.folder, item.name));
                    result.error = Some(e);
                }
            }
            result
        })
        .collect()
}

fn copy_one(
    src: &Path,
    dir: &Path,
    name: &str,
    expected: u64,
    taken: &mut HashSet<PathBuf>,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Folder tujuan tidak bisa dibuat: {e}"))?;

    // Copy under a temporary name first, so an interrupted copy never looks
    // like a finished file.
    let tmp = dir.join(format!(".{name}.{}.partial", std::process::id()));
    let cleanup = |e: String| {
        let _ = std::fs::remove_file(&tmp);
        e
    };
    let written = std::fs::copy(src, &tmp).map_err(|e| cleanup(format!("Gagal menyalin: {e}")))?;
    let source_now = std::fs::metadata(src).map(|m| m.len()).unwrap_or(u64::MAX);
    let copied = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(u64::MAX);
    if written != expected || source_now != expected || copied != expected {
        return Err(cleanup("File sumber berubah atau salinan tidak utuh.".into()));
    }

    // Give the copy its final name without ever replacing an existing file:
    // hard_link fails if the name exists, whereas rename would overwrite.
    for _ in 0..50 {
        let Some(final_name) = free_name(dir, name, taken) else { break };
        let dest = dir.join(&final_name);
        match std::fs::hard_link(&tmp, &dest) {
            Ok(()) => {
                let _ = std::fs::remove_file(&tmp);
                taken.insert(dest.clone());
                // "Selesai" only for a copy we can see on disk at the right size.
                return match std::fs::metadata(&dest) {
                    Ok(m) if m.len() == expected => Ok(dest),
                    _ => Err("Salinan tidak ditemukan setelah disimpan.".into()),
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                // Volumes without hard links: check, then rename.
                if dest.exists() {
                    continue;
                }
                return match std::fs::rename(&tmp, &dest) {
                    Ok(()) => {
                        taken.insert(dest.clone());
                        Ok(dest)
                    }
                    Err(e) => Err(cleanup(format!("Gagal menyimpan salinan: {e}"))),
                };
            }
        }
    }
    Err(cleanup("Tidak menemukan nama tujuan yang kosong.".into()))
}

/// Shows a copied file in Explorer — only files under the drop root.
pub fn reveal(path: &str) -> Result<(), String> {
    let root = root_dir().canonicalize().map_err(|e| e.to_string())?;
    let target = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&root) {
        return Err("Hanya file di folder penampungan yang bisa dibuka.".into());
    }
    platform::reveal_file(&target);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_follow_the_prd_table() {
        assert_eq!(folder_for("a.PDF"), "Documents");
        assert_eq!(folder_for("a.docx"), "Documents");
        assert_eq!(folder_for("a.JpEg"), "Images");
        assert_eq!(folder_for("a.csv"), "Data");
        assert_eq!(folder_for("a.7z"), "Archive");
        assert_eq!(folder_for("a.exe"), "Inbox");
        assert_eq!(folder_for("noext"), "Inbox");
    }

    #[test]
    fn copies_verify_and_never_overwrite() {
        let base = std::env::temp_dir().join(format!("dinusaurus-test-{}", std::process::id()));
        let dir = base.join("Documents");
        std::fs::create_dir_all(&base).unwrap();
        let src = base.join("note.txt");
        std::fs::write(&src, b"hello").unwrap();

        let mut taken = HashSet::new();
        let first = copy_one(&src, &dir, "note.txt", 5, &mut taken).unwrap();
        assert_eq!(first.file_name().unwrap(), "note.txt");

        std::fs::write(&src, b"world").unwrap();
        let second = copy_one(&src, &dir, "note.txt", 5, &mut taken).unwrap();
        assert_eq!(second.file_name().unwrap(), "note (2).txt");
        assert_eq!(std::fs::read(&first).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second).unwrap(), b"world");

        // A size mismatch fails and leaves no partial file behind.
        assert!(copy_one(&src, &dir, "note.txt", 999, &mut taken).is_err());
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".partial"))
            .count();
        assert_eq!(leftovers, 0);

        let _ = std::fs::remove_dir_all(&base);
    }
}
