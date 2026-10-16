// The diff card's ↗: the file a live diff shows, opened in VS Code. Ported from
// upstream (Louis-CFM/coucou 122e130), where it lived in lib.rs.

use std::path::Path;
use std::process::Command;

use crate::platform;

/// The file behind a live diff, if it may be handed to the editor: an existing
/// regular file given by its full path. Anything else (a relative path, a
/// folder, a path `code` could read as an option) goes no further.
fn diff_file(path: &str) -> Option<&Path> {
    let p = Path::new(path);
    (p.is_absolute() && p.is_file()).then_some(p)
}

/// Opens the edited file in VS Code when `code` is on PATH, otherwise shows its
/// folder. The file itself is never opened by its type: Explorer would run a
/// script that Claude just wrote.
#[tauri::command]
pub fn open_file_in_vscode(path: String) -> bool {
    let Some(file) = diff_file(&path) else { return false };
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        cmd.arg(file);
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(folder) = file.parent().filter(|d| d.is_dir()) {
        platform::reveal_folder(&folder.to_string_lossy());
    }
    false
}

#[cfg(test)]
mod tests {
    use super::diff_file;

    #[test]
    fn only_an_existing_file_by_its_full_path_reaches_the_editor() {
        let dir = std::env::temp_dir().join(format!("coucou-diff-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("edited.ts");
        std::fs::write(&file, "x").unwrap();

        assert!(diff_file(&file.to_string_lossy()).is_some());
        // A folder, a missing file, a relative path or an option never pass.
        assert!(diff_file(&dir.to_string_lossy()).is_none());
        assert!(diff_file(&dir.join("missing.ts").to_string_lossy()).is_none());
        assert!(diff_file("edited.ts").is_none());
        assert!(diff_file("--help").is_none());
        assert!(diff_file("").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
