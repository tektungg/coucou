// Saving the weekly recap's shared image (a PNG the island drew) to the
// pictures folder. Part of recap/ (see mod.rs).

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use super::payload::is_week_key;

/// A 1080 × 1920 PNG is ~1 MB; anything far larger is not our image.
const MAX_PNG_BYTES: usize = 24 << 20;

/// Standard base64, with or without a `data:…;base64,` prefix.
pub(super) fn decode_base64(data: &str) -> Option<Vec<u8>> {
    let body = match data.split_once(',') {
        Some((head, rest)) if head.starts_with("data:") => rest,
        _ => data,
    };
    let mut out = Vec::with_capacity(body.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0u32;
    let mut padding = false;
    for b in body.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                padding = true;
                continue;
            }
            b'\r' | b'\n' => continue,
            _ => return None,
        };
        if padding {
            return None;
        }
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n'];

/// Writes `bytes` as `<stem>.png` in `dir`, or `<stem> (2).png`… when that name
/// is taken. An existing file is never replaced.
pub(super) fn write_unique(dir: &Path, stem: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    for n in 1..1000 {
        let name = if n == 1 { format!("{stem}.png") } else { format!("{stem} ({n}).png") };
        let path = dir.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let written = file.write_all(bytes).and_then(|()| file.sync_all());
                drop(file);
                if let Err(err) = written {
                    let _ = std::fs::remove_file(&path);
                    return Err(err);
                }
                return Ok(path);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(ErrorKind::AlreadyExists, "too many recap images with this name"))
}

/// The PNG the page rendered, checked and written to the first pictures folder
/// that exists.
pub(super) fn save_png(dirs: &[PathBuf], data: &str, week: &str) -> Result<PathBuf, String> {
    if data.len() > MAX_PNG_BYTES / 3 * 4 + 64 {
        return Err("The image is too large.".into());
    }
    let bytes = decode_base64(data).ok_or("The image could not be read.")?;
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("The image could not be read.".into());
    }
    let dir = dirs.iter().find(|d| d.is_dir()).ok_or("No Pictures or Downloads folder to save into.")?;
    let stem = if is_week_key(week) {
        format!("Coucou weekly recap {week}")
    } else {
        "Coucou weekly recap".to_string()
    };
    write_unique(dir, &stem, &bytes).map_err(|err| format!("Could not save the image: {err}"))
}
