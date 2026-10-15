// Launch at login: the OS entry follows the setting *and* the exe that runs.
//
// The entry stores a path. Installed per-machine once and per-user later, the
// old `C:\Program Files\Coucou\coucou.exe` stayed in the Run key while the
// setting kept saying "on", and nothing ever looked again: Coucou silently
// stopped starting at login. So the entry is checked at every launch, not only
// when the toggle moves.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

use crate::{log, platform};

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Enable,
    Disable,
    Nothing,
}

/// What to do with the login entry.
///
/// `registered` is the command the OS currently holds (`None`: no entry, or one
/// we cannot read). A debug build never touches it: its exe sits in
/// `target\debug` and would replace the installed app at the next login. An
/// entry already naming this exe is left alone, so a "Disabled" set in Task
/// Manager's Startup apps is respected.
pub fn action(wanted: bool, registered: Option<&str>, exe: &str, debug_build: bool) -> Action {
    if debug_build {
        return Action::Nothing;
    }
    match (wanted, registered) {
        (true, Some(cmd)) if same_exe(cmd, exe) => Action::Nothing,
        (true, _) => Action::Enable,
        (false, Some(_)) => Action::Disable,
        (false, None) => Action::Nothing,
    }
}

/// The program part of a login command: quotes, arguments and the `\\?\`
/// prefix removed, lowercased (Windows paths are case-insensitive).
fn program_of(command: &str) -> String {
    // Lowercased first, so every index below is into the same string.
    let c = command.trim().to_lowercase();
    let program = match c.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(rest),
        // Unquoted: everything up to the exe, so a path with spaces survives.
        None => match c.find(".exe") {
            Some(end) => &c[..end + 4],
            None => c.split_whitespace().next().unwrap_or(&c),
        },
    };
    program.trim_start_matches(r"\\?\").to_string()
}

fn same_exe(command: &str, exe: &str) -> bool {
    program_of(command) == program_of(exe)
}

/// Brings the login entry in line with `wanted` and the running exe.
pub fn sync(app: &AppHandle, wanted: bool) {
    let exe = match std::env::current_exe() {
        Ok(p) => p.display().to_string(),
        Err(err) => {
            log::line(format!("autostart: no exe path ({err})"));
            return;
        }
    };
    let name = app.package_info().name.clone();
    let registered = platform::login_item_command(&name);
    let manager = app.autolaunch();
    let (result, what) = match action(wanted, registered.as_deref(), &exe, cfg!(debug_assertions)) {
        Action::Enable => (manager.enable(), format!("on: {exe}")),
        Action::Disable => (manager.disable(), "off".to_string()),
        Action::Nothing => return,
    };
    match result {
        Ok(()) => log::line(format!("autostart {what}")),
        Err(err) => log::line(format!("autostart {what} failed: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Users\me\AppData\Local\Coucou\coucou.exe";

    #[test]
    fn stale_path_is_rewritten() {
        let old = r"C:\Program Files\Coucou\coucou.exe";
        assert_eq!(action(true, Some(old), EXE, false), Action::Enable);
    }

    #[test]
    fn missing_entry_is_written() {
        assert_eq!(action(true, None, EXE, false), Action::Enable);
    }

    #[test]
    fn current_entry_is_left_alone() {
        assert_eq!(action(true, Some(EXE), EXE, false), Action::Nothing);
        let quoted = format!("\"{}\" --minimized", EXE.to_uppercase());
        assert_eq!(action(true, Some(&quoted), EXE, false), Action::Nothing);
        let verbatim = format!(r"\\?\{EXE}");
        assert_eq!(action(true, Some(EXE), &verbatim, false), Action::Nothing);
    }

    #[test]
    fn off_removes_an_entry_only_when_there_is_one() {
        assert_eq!(action(false, Some(EXE), EXE, false), Action::Disable);
        assert_eq!(action(false, None, EXE, false), Action::Nothing);
    }

    #[test]
    fn debug_build_never_touches_the_entry() {
        assert_eq!(action(true, None, EXE, true), Action::Nothing);
        assert_eq!(action(false, Some(EXE), EXE, true), Action::Nothing);
    }

    #[test]
    fn program_handles_spaces_and_arguments() {
        assert_eq!(
            program_of(r"C:\Program Files\Coucou\coucou.exe --autostart"),
            r"c:\program files\coucou\coucou.exe"
        );
        assert_eq!(program_of(r#""C:\A B\x.exe" -silent"#), r"c:\a b\x.exe");
        assert_eq!(program_of("/opt/coucou/coucou --hidden"), "/opt/coucou/coucou");
    }
}
