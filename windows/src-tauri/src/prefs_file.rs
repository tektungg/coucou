// Reading and writing a preferences file (settings.json) without ever losing
// what the user had in it.
//
// The rules, ported from upstream (Louis-CFM/coucou d8d2939):
// - A file that is not there means the defaults, and nothing else happens.
// - A UTF-8 BOM (Notepad, PowerShell 5) or a blank file is not corruption.
// - One field of the wrong kind falls back to its default on its own instead
//   of costing every other setting; unknown fields are ignored.
// - A file that cannot be used at all is copied aside byte for byte
//   (`settings.json.corrupt-YYYYMMDD-HHMMSS`) before the defaults take over.
// - A file that could not even be read is never saved over unseen: the next
//   save copies it aside first, or is refused while it still can't be read.
// - A save writes a temporary file beside the target and renames it over, so
//   a crash or a full disk leaves the previous file whole.

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};

/// How many copies `set_aside` can make within one second before it gives up.
const MAX_COPIES_PER_SECOND: u32 = 100;

/// The bytes Notepad and PowerShell 5 put in front of UTF-8 text.
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// Files that are there but whose contents never made it into memory: what is
/// in memory for them is the defaults, so the next save must not quietly
/// replace them (see `keep_what_was_not_loaded`).
static NOT_LOADED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// One save at a time: two would share the temporary file's name.
static SAVING: Mutex<()> = Mutex::new(());

fn lock<T>(mutex: &'static Mutex<T>) -> MutexGuard<'static, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One line in coucou.log. Tests never write to the real one.
fn note(message: String) {
    #[cfg(not(test))]
    crate::log::line(message);
    #[cfg(test)]
    eprintln!("{message}");
}

/// The value held in the bytes of a preferences file, or `None` when nothing
/// in them is usable.
pub(crate) fn parse<T: Serialize + DeserializeOwned + Default>(bytes: &[u8]) -> Option<T> {
    let text = bytes.strip_prefix(&UTF8_BOM).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Some(T::default());
    }
    let Value::Object(fields) = serde_json::from_slice(text).ok()? else {
        return None;
    };
    let whole = serde_json::from_value(Value::Object(fields.clone()));
    Some(whole.unwrap_or_else(|_| salvage(fields)))
}

/// A value from the fields of a file that does not load as a whole: each field
/// is tried on its own, and one that does not fit keeps its default.
fn salvage<T: Serialize + DeserializeOwned + Default>(fields: Map<String, Value>) -> T {
    let Ok(Value::Object(mut kept)) = serde_json::to_value(T::default()) else {
        return T::default();
    };
    for (key, value) in fields {
        let mut candidate = kept.clone();
        candidate.insert(key.clone(), value);
        if serde_json::from_value::<T>(Value::Object(candidate.clone())).is_ok() {
            kept = candidate;
        } else {
            note(unusable_field(&key));
        }
    }
    serde_json::from_value(Value::Object(kept)).unwrap_or_default()
}

/// The log line for a field `salvage` dropped. The name comes from the file,
/// so it is escaped: a line break in it cannot fake another log line.
fn unusable_field(key: &str) -> String {
    format!("settings: field {key:?} is not usable, its default is used instead")
}

/// Loads the file at `path`, or the defaults when it is missing or unusable.
pub fn load_from<T: Serialize + DeserializeOwned + Default>(path: &Path) -> T {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return T::default(),
        Err(err) => {
            note(format!("settings: can't read {}: {err}, using the defaults", path.display()));
            protect(path);
            return T::default();
        }
    };
    parse(&bytes).unwrap_or_else(|| {
        match set_aside(path, "corrupt", &bytes) {
            Ok(copy) => note(format!(
                "settings: {} is not usable, kept as {}, using the defaults",
                path.display(),
                copy.display()
            )),
            Err(err) => {
                note(format!("settings: {} is not usable and could not be copied: {err}", path.display()));
                protect(path);
            }
        }
        T::default()
    })
}

/// Marks `path` as holding something the next save must not write over.
fn protect(path: &Path) {
    let mut pending = lock(&NOT_LOADED);
    if !pending.iter().any(|p| p == path) {
        pending.push(path.to_path_buf());
    }
}

/// Before the first save over a file `load_from` could not load: copies it
/// aside if it can be read by now, and refuses the save if it still cannot.
fn keep_what_was_not_loaded(path: &Path) -> std::io::Result<()> {
    let mut pending = lock(&NOT_LOADED);
    let Some(index) = pending.iter().position(|p| p == path) else {
        return Ok(());
    };
    match std::fs::read(path) {
        Ok(bytes) => {
            let copy = set_aside(path, "unread", &bytes)?;
            note(format!("settings: {} was never loaded, kept as {}", path.display(), copy.display()));
        }
        // Gone since: nothing is left to protect.
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => {
            return Err(std::io::Error::new(
                err.kind(),
                format!("{} still can't be read, so it is left as it is: {err}", path.display()),
            ));
        }
    }
    pending.swap_remove(index);
    Ok(())
}

/// Keeps `bytes`, the contents of `path`, beside it as
/// `<name>.<kind>-YYYYMMDD-HHMMSS`. Contents an earlier copy of that kind
/// already holds are not copied again, so a file nobody repairs does not
/// leave one more copy behind at every launch.
fn set_aside(path: &Path, kind: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    if let Some(copy) = same_copy(path, kind, bytes) {
        return Ok(copy);
    }
    let t = crate::platform::local_time();
    let stamp = format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    );
    set_aside_as(path, &format!("{kind}-{stamp}"), bytes, write_whole)
}

/// The copy of `path` of this `kind` that already holds exactly `bytes`.
fn same_copy(path: &Path, kind: &str, bytes: &[u8]) -> Option<PathBuf> {
    let prefix = format!("{}.{kind}-", path.file_name()?.to_string_lossy());
    std::fs::read_dir(path.parent()?)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .filter(|entry| entry.metadata().is_ok_and(|m| m.len() == bytes.len() as u64))
        .map(|entry| entry.path())
        .find(|copy| std::fs::read(copy).is_ok_and(|held| held == bytes))
}

/// `set_aside` under the name `<name>.<suffix>`, writing through `write`.
/// `-1`, `-2`… are appended while the name is taken, so an earlier copy is
/// never written over; a copy that could not be written whole is removed.
fn set_aside_as(
    path: &Path,
    suffix: &str,
    bytes: &[u8],
    write: fn(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
) -> std::io::Result<PathBuf> {
    let base = format!("{}.{suffix}", path.file_name().unwrap_or_default().to_string_lossy());
    for attempt in 0..MAX_COPIES_PER_SECOND {
        let copy = match attempt {
            0 => path.with_file_name(&base),
            n => path.with_file_name(format!("{base}-{n}")),
        };
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&copy) {
            Ok(mut file) => {
                let written = write(&mut file, bytes);
                drop(file);
                if written.is_err() {
                    let _ = std::fs::remove_file(&copy);
                }
                return written.map(|()| copy);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(ErrorKind::AlreadyExists, format!("too many copies named {base}")))
}

/// Writes `bytes` to `file` and waits until they are on the disk.
fn write_whole(file: &mut std::fs::File, bytes: &[u8]) -> std::io::Result<()> {
    file.write_all(bytes)?;
    file.sync_all()
}

/// Saves `value` to `path`, whose directory already exists.
pub fn save_to<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let _one_at_a_time = lock(&SAVING);
    keep_what_was_not_loaded(path)?;
    let json = serde_json::to_vec_pretty(value).map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))?;

    // A dotfiles setup can make the file a symlink: write to what it points
    // at, so the link survives the rename below.
    #[cfg(unix)]
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(unix)]
    let path = resolved.as_path();

    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let temp = path.with_file_name(format!("{name}.coucou-{}", std::process::id()));
    let written = std::fs::File::create(&temp)
        .and_then(|mut file| write_whole(&mut file, &json))
        .and_then(|()| std::fs::rename(&temp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    /// A stand-in for Settings: the rules do not depend on which fields exist.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    struct Prefs {
        sound_enabled: bool,
        sound_volume: f64,
        apps: Vec<String>,
        screen: String,
    }

    impl Default for Prefs {
        fn default() -> Self {
            Self { sound_enabled: true, sound_volume: 0.12, apps: vec!["slack".into()], screen: "primary".into() }
        }
    }

    /// A file in which no value is the default one.
    const CUSTOM: &str = r#"{
  "soundEnabled": false,
  "soundVolume": 0.5,
  "apps": ["discord", "telegram"],
  "screen": "cursor"
}"#;

    fn custom() -> Prefs {
        serde_json::from_str(CUSTOM).unwrap()
    }

    /// `CUSTOM` with one key replaced, or removed when `value` is `None`.
    fn custom_with(key: &str, value: Option<Value>) -> Vec<u8> {
        let mut object: Map<String, Value> = serde_json::from_str(CUSTOM).unwrap();
        match value {
            Some(value) => object.insert(key.to_string(), value),
            None => object.remove(key),
        };
        serde_json::to_vec(&object).unwrap()
    }

    /// A fresh directory of our own, and the settings.json it will hold.
    fn scratch(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("coucou-prefs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        (dir, file)
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    /// What was set aside under `settings.json.<kind>-…`.
    fn kept(dir: &Path, kind: &str) -> Vec<Vec<u8>> {
        let prefix = format!("settings.json.{kind}-");
        names(dir)
            .iter()
            .filter(|name| name.starts_with(&prefix))
            .map(|name| std::fs::read(dir.join(name)).unwrap())
            .collect()
    }

    // ── Reading ───────────────────────────────────────────────────────────────

    #[test]
    fn a_missing_file_is_the_defaults_and_is_not_created() {
        let (dir, file) = scratch("missing");
        assert_eq!(load_from::<Prefs>(&file), Prefs::default());
        assert!(names(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_file_is_the_defaults_and_nothing_is_set_aside() {
        let (dir, file) = scratch("empty");
        for nothing in [&b""[..], &b" \r\n\t "[..]] {
            std::fs::write(&file, nothing).unwrap();
            assert_eq!(load_from::<Prefs>(&file), Prefs::default());
        }
        assert_eq!(names(&dir), ["settings.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_fields_are_ignored_and_the_known_ones_kept() {
        let bytes = custom_with("somethingFromALaterVersion", Some(json!({ "a": [1, 2] })));
        assert_eq!(parse::<Prefs>(&bytes).unwrap(), custom());
    }

    #[test]
    fn a_missing_field_takes_its_default_and_the_rest_are_kept() {
        let mut expected = custom();
        expected.apps = Prefs::default().apps;
        assert_eq!(parse::<Prefs>(&custom_with("apps", None)).unwrap(), expected);
    }

    #[test]
    fn a_field_of_the_wrong_type_takes_its_default_and_the_rest_are_kept() {
        let defaults = serde_json::to_value(Prefs::default()).unwrap();
        for (key, wrong) in [
            ("soundVolume", json!("loud")),
            ("soundEnabled", json!(1)),
            ("apps", json!("slack")),
            ("screen", Value::Null),
        ] {
            let loaded = parse::<Prefs>(&custom_with(key, Some(wrong)))
                .unwrap_or_else(|| panic!("a file with a bad {key} was thrown away"));
            let mut expected = serde_json::to_value(custom()).unwrap();
            expected[key] = defaults[key].clone();
            assert_eq!(serde_json::to_value(loaded).unwrap(), expected, "bad {key}");
        }
    }

    #[test]
    fn a_utf8_bom_is_not_corruption() {
        let (dir, file) = scratch("bom");
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(CUSTOM.as_bytes());
        std::fs::write(&file, &bytes).unwrap();
        assert_eq!(load_from::<Prefs>(&file), custom());
        assert_eq!(names(&dir), ["settings.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unusable_file_is_the_defaults_and_is_set_aside_byte_for_byte() {
        for (name, bad) in [
            ("invalid", &b"{ \"soundVolume\": 0.5, \xff oops"[..]),
            ("not-an-object", &b"[1, 2, 3]"[..]),
        ] {
            let (dir, file) = scratch(name);
            std::fs::write(&file, bad).unwrap();
            assert_eq!(load_from::<Prefs>(&file), Prefs::default());
            assert_eq!(kept(&dir, "corrupt"), [bad.to_vec()], "{name}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_second_unusable_file_never_replaces_the_copy_of_the_first() {
        // Both within the same second: the names must still differ.
        let (dir, file) = scratch("twice");
        let (first, second) = (&b"{ first"[..], &b"{ second"[..]);
        std::fs::write(&file, first).unwrap();
        load_from::<Prefs>(&file);
        std::fs::write(&file, second).unwrap();
        load_from::<Prefs>(&file);
        let mut copies = kept(&dir, "corrupt");
        copies.sort();
        assert_eq!(copies, [first.to_vec(), second.to_vec()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unusable_file_is_set_aside_once_however_often_it_is_loaded() {
        let (dir, file) = scratch("once");
        std::fs::write(&file, b"{ broken").unwrap();
        for _ in 0..3 {
            load_from::<Prefs>(&file);
        }
        assert_eq!(kept(&dir, "corrupt"), [b"{ broken".to_vec()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_could_not_be_read_is_never_saved_over_unseen() {
        // A directory in the file's place: a read error that is not "not found".
        let (dir, file) = scratch("unread");
        std::fs::create_dir(&file).unwrap();
        let loaded = load_from::<Prefs>(&file);
        assert_eq!(loaded, Prefs::default());

        // Still unreadable: the save is refused and nothing is touched.
        assert!(save_to(&file, &loaded).is_err());
        assert!(file.is_dir());
        assert_eq!(names(&dir), ["settings.json"]);

        // Readable by now: kept aside first, and only then saved over.
        std::fs::remove_dir(&file).unwrap();
        std::fs::write(&file, CUSTOM).unwrap();
        save_to(&file, &loaded).unwrap();
        assert_eq!(kept(&dir, "unread"), [CUSTOM.as_bytes().to_vec()]);
        assert_eq!(load_from::<Prefs>(&file), Prefs::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Opens `path` the way a process that shares nothing does: nobody else can
    /// read or write it until the handle is dropped.
    #[cfg(windows)]
    fn locked(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn a_file_locked_at_launch_is_not_saved_over_while_still_locked() {
        let (dir, file) = scratch("locked");
        std::fs::write(&file, CUSTOM).unwrap();
        let lock = locked(&file);
        let loaded = load_from::<Prefs>(&file);
        assert_eq!(loaded, Prefs::default());
        assert!(save_to(&file, &loaded).is_err());
        drop(lock);
        assert_eq!(std::fs::read(&file).unwrap(), CUSTOM.as_bytes());

        // Free again: kept aside, then saved over.
        save_to(&file, &loaded).unwrap();
        assert_eq!(kept(&dir, "unread"), [CUSTOM.as_bytes().to_vec()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Copies set aside ──────────────────────────────────────────────────────

    #[test]
    fn copies_made_within_the_same_second_are_numbered_and_none_is_written_over() {
        let (dir, file) = scratch("numbered");
        let suffix = "corrupt-20260102-030405";
        let contents = [&b"one"[..], &b"two"[..], &b"three"[..]];
        let copies: Vec<PathBuf> = contents
            .iter()
            .map(|bytes| set_aside_as(&file, suffix, bytes, write_whole).unwrap())
            .collect();
        let named = |n: &str| dir.join(format!("settings.json.{suffix}{n}"));
        assert_eq!(copies, [named(""), named("-1"), named("-2")]);
        for (copy, bytes) in copies.iter().zip(contents) {
            assert_eq!(std::fs::read(copy).unwrap(), bytes);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_copy_that_could_not_be_written_whole_is_removed() {
        fn half_then_fail(file: &mut std::fs::File, bytes: &[u8]) -> std::io::Result<()> {
            file.write_all(&bytes[..bytes.len() / 2])?;
            Err(std::io::Error::other("the disk is full"))
        }
        let (dir, file) = scratch("half");
        assert!(set_aside_as(&file, "corrupt-20260102-030405", b"all of it", half_then_fail).is_err());
        assert!(names(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_field_name_cannot_start_a_line_of_its_own_in_the_log() {
        let line = unusable_field("volume\r\n2026-01-02 03:04:05 hook id=1 answered allow");
        assert!(!line.contains(['\r', '\n']));
        assert!(line.contains(r"volume\r\n2026-01-02"));
    }

    // ── Writing ───────────────────────────────────────────────────────────────

    #[test]
    fn every_field_survives_a_save_and_a_load() {
        let (dir, file) = scratch("round-trip");
        save_to(&file, &custom()).unwrap();
        assert_eq!(load_from::<Prefs>(&file), custom());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_replaces_the_file_and_leaves_nothing_else_behind() {
        let (dir, file) = scratch("tidy");
        std::fs::write(&file, CUSTOM).unwrap();
        save_to(&file, &Prefs::default()).unwrap();
        save_to(&file, &Prefs::default()).unwrap();
        assert_eq!(load_from::<Prefs>(&file), Prefs::default());
        assert_eq!(names(&dir), ["settings.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_temporary_file_that_cannot_be_written_leaves_the_original_alone() {
        // A directory squatting on the temporary file's name: the write cannot start.
        let (dir, file) = scratch("blocked");
        std::fs::write(&file, CUSTOM).unwrap();
        std::fs::create_dir(dir.join(format!("settings.json.coucou-{}", std::process::id()))).unwrap();
        assert!(save_to(&file, &Prefs::default()).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), CUSTOM.as_bytes());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
