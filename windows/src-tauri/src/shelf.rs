// The Shelf pill: files the user dropped on Mochi (kept by reference, never
// copied or moved), plus the latest screenshots and downloads. From the card
// a file can be dragged out to any app, copied to the clipboard, opened, or
// shown in Explorer.
//
// Every decision (what is recent, what is a partial download, which kind a
// file is, the pinned list, the clipboard buffer, which paths the island may
// act on) is a pure function tested below; `imp` only does the Windows calls.
// File names never reach the log.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// Screenshots and downloads older than this are not "recent".
pub const RECENT_MS: i64 = 3 * 24 * 60 * 60 * 1000;
/// Newest files shown per folder.
pub const RECENT_MAX: usize = 12;
/// Files kept on the shelf; the oldest pin goes first.
pub const PINNED_MAX: usize = 50;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Unix ms.
    pub modified: i64,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Snapshot {
    pub pinned: Vec<Item>,
    pub screenshots: Vec<Item>,
    pub downloads: Vec<Item>,
}

impl Snapshot {
    fn all(&self) -> impl Iterator<Item = &Item> {
        self.pinned.iter().chain(&self.screenshots).chain(&self.downloads)
    }
}

/// What the listing knows about one directory entry.
#[derive(Debug, Clone)]
pub(crate) struct Entry {
    pub path: PathBuf,
    pub size: u64,
    pub modified: i64,
    pub is_dir: bool,
    pub hidden: bool,
}

/// The kind the card picks an icon colour for, from the extension.
pub(crate) fn kind_of(name: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return "folder";
    }
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "heic" | "avif" | "svg" | "ico" | "tif" | "tiff" => "image",
        "mp4" | "mov" | "mkv" | "webm" | "avi" | "wmv" | "m4v" => "video",
        "mp3" | "wav" | "flac" | "m4a" | "aac" | "ogg" | "opus" => "audio",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "rtf" | "csv" | "odt" | "pages" => "doc",
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "iso" => "archive",
        "exe" | "msi" | "msix" | "appx" | "bat" | "cmd" | "ps1" => "app",
        "js" | "ts" | "tsx" | "jsx" | "rs" | "py" | "go" | "java" | "kt" | "swift" | "dart" | "json" | "yaml" | "yml"
        | "toml" | "html" | "css" | "sql" | "sh" | "php" | "rb" | "c" | "cpp" | "h" | "cs" => "code",
        _ => "other",
    }
}

/// Downloads still in progress, Office lock files, and the folder's own files.
pub(crate) fn is_partial_or_system(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    const PARTIAL: &[&str] = &[".crdownload", ".part", ".partial", ".tmp", ".opdownload", ".download", ".!ut"];
    PARTIAL.iter().any(|ext| lower.ends_with(ext))
        || lower == "desktop.ini"
        || lower == "thumbs.db"
        || lower.starts_with("~$")
        || lower.starts_with('.')
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn item(e: &Entry) -> Item {
    let name = file_name(&e.path);
    Item {
        path: e.path.to_string_lossy().into_owned(),
        kind: kind_of(&name, e.is_dir),
        name,
        size: e.size,
        modified: e.modified,
    }
}

/// The newest files of a folder: files only, not partial, hidden or system,
/// modified in the last RECENT_MS (and not in the future by more than a
/// minute, a clock gone wrong), newest first, at most RECENT_MAX.
pub(crate) fn pick_recent(entries: &[Entry], now_ms: i64) -> Vec<Item> {
    let mut recent: Vec<&Entry> = entries
        .iter()
        .filter(|e| !e.is_dir && !e.hidden && !is_partial_or_system(&file_name(&e.path)))
        .filter(|e| e.modified >= now_ms - RECENT_MS && e.modified <= now_ms + 60_000)
        .collect();
    recent.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.path.cmp(&b.path)));
    recent.into_iter().take(RECENT_MAX).map(item).collect()
}

/// Puts `paths` at the front of the shelf, newest first, without duplicates
/// (same path in any case), keeping the newest PINNED_MAX.
pub(crate) fn pin(list: &mut Vec<String>, paths: &[String]) {
    for p in paths.iter().rev() {
        list.retain(|x| !same_path(x, p));
        list.insert(0, p.clone());
    }
    list.truncate(PINNED_MAX);
}

pub(crate) fn unpin(list: &mut Vec<String>, path: &str) {
    list.retain(|x| !same_path(x, path));
}

/// Windows paths are case-insensitive.
pub(crate) fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Whether the island may act on `path`: only what the card shows.
pub(crate) fn allowed(snapshot: &Snapshot, path: &str) -> bool {
    snapshot.all().any(|i| same_path(&i.path, path))
}

/// The CF_HDROP clipboard payload: a DROPFILES header (offset 20, wide
/// names) then each path in UTF-16, NUL-terminated, and a final NUL.
pub(crate) fn dropfiles_bytes(paths: &[String]) -> Vec<u8> {
    let mut out = Vec::with_capacity(20 + paths.iter().map(|p| (p.len() + 1) * 2).sum::<usize>() + 2);
    out.extend_from_slice(&20u32.to_le_bytes()); // pFiles
    out.extend_from_slice(&0i32.to_le_bytes()); // pt.x
    out.extend_from_slice(&0i32.to_le_bytes()); // pt.y
    out.extend_from_slice(&0i32.to_le_bytes()); // fNC
    out.extend_from_slice(&1i32.to_le_bytes()); // fWide
    for p in paths {
        for unit in p.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out.extend_from_slice(&[0, 0]);
    }
    out.extend_from_slice(&[0, 0]);
    out
}

// ── State: the pinned list and the last snapshot ─────────────────────────────

static PINNED: Mutex<Option<Vec<String>>> = Mutex::new(None);
static LAST: Mutex<Option<Snapshot>> = Mutex::new(None);

fn pins_path() -> PathBuf {
    crate::settings::config_dir().join("shelf.json")
}

pub(crate) fn load_pins(path: &Path) -> Vec<String> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub(crate) fn save_pins(path: &Path, list: &[String]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        crate::platform::ensure_private_dir(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn with_pins<T>(f: impl FnOnce(&mut Vec<String>) -> T) -> T {
    let mut guard = PINNED.lock().unwrap();
    let list = guard.get_or_insert_with(|| load_pins(&pins_path()));
    f(list)
}

fn entry(path: &Path) -> Option<Entry> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(Entry { path: path.to_path_buf(), size: meta.len(), modified, is_dir: meta.is_dir(), hidden: is_hidden(&meta) })
}

#[cfg(windows)]
fn is_hidden(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    meta.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn is_hidden(_meta: &std::fs::Metadata) -> bool {
    false
}

fn list_dir(dir: &Path) -> Vec<Entry> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    read.filter_map(|e| e.ok()).filter_map(|e| entry(&e.path())).collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Reads everything the card shows. Blocking (file system); pins whose file
/// is gone are dropped from the shelf.
pub fn snapshot() -> Snapshot {
    let pinned = with_pins(|list| {
        let before = list.len();
        let entries: Vec<Entry> = list.iter().filter_map(|p| entry(Path::new(p))).collect();
        list.retain(|p| entries.iter().any(|e| same_path(&e.path.to_string_lossy(), p)));
        if list.len() != before {
            let _ = save_pins(&pins_path(), list);
        }
        entries.iter().map(item).collect::<Vec<_>>()
    });
    let now = now_ms();
    let snap = Snapshot {
        pinned,
        screenshots: imp::screenshots_dir().map(|d| pick_recent(&list_dir(&d), now)).unwrap_or_default(),
        downloads: imp::downloads_dir().map(|d| pick_recent(&list_dir(&d), now)).unwrap_or_default(),
    };
    *LAST.lock().unwrap() = Some(snap.clone());
    snap
}

/// Err unless the card currently shows `path`.
fn check(path: &str) -> Result<(), String> {
    let ok = LAST.lock().unwrap().as_ref().is_some_and(|s| allowed(s, path));
    if ok {
        Ok(())
    } else {
        Err("That file is not on the shelf".into())
    }
}

/// Keeps dropped files and folders on the shelf (by reference).
pub fn pin_paths(paths: &[String]) -> Result<(), String> {
    let existing: Vec<String> = paths
        .iter()
        .filter(|p| Path::new(p).is_absolute() && Path::new(p).exists())
        .cloned()
        .collect();
    if existing.is_empty() {
        return Err("Nothing to keep: the files are gone".into());
    }
    with_pins(|list| {
        pin(list, &existing);
        save_pins(&pins_path(), list)
    })
}

pub fn unpin_path(path: &str) -> Result<(), String> {
    with_pins(|list| {
        unpin(list, path);
        save_pins(&pins_path(), list)
    })
}

pub fn clear_pins() -> Result<(), String> {
    with_pins(|list| {
        list.clear();
        save_pins(&pins_path(), list)
    })
}

/// Opens with the default app.
pub fn open(path: &str) -> Result<(), String> {
    check(path)?;
    imp::open(path)
}

/// Shows it selected in Explorer.
pub fn reveal(path: &str) -> Result<(), String> {
    check(path)?;
    imp::reveal(path)
}

/// Puts it on the clipboard as a file (and as a picture when it is one).
/// Blocking.
pub fn copy(path: &str) -> Result<(), String> {
    check(path)?;
    let is_image = kind_of(path, false) == "image";
    imp::copy(path, is_image)
}

/// A PNG data URL of Explorer's own thumbnail (or icon) for the file.
/// Blocking; cached by path and modification time.
pub fn thumbnail(path: &str) -> Result<Option<String>, String> {
    check(path)?;
    let modified = entry(Path::new(path)).map(|e| e.modified).unwrap_or(0);
    let key = format!("{path}\u{1f}{modified}");
    if let Some(hit) = thumbs::get(&key) {
        return Ok(hit);
    }
    let url = imp::thumbnail_png(Path::new(path), THUMB_PX).map(|png| {
        use base64::Engine as _;
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
    });
    thumbs::put(key, url.clone());
    Ok(url)
}

/// Thumbnails are drawn at 48 px; twice that for high-DPI screens.
pub const THUMB_PX: i32 = 96;

/// The PNG the OS drag shows under the cursor.
pub fn drag_preview(path: &str) -> Option<Vec<u8>> {
    imp::thumbnail_png(Path::new(path), THUMB_PX)
}

/// Checks every path, for the drag.
pub fn check_all(paths: &[String]) -> Result<(), String> {
    paths.iter().try_for_each(|p| check(p))
}

mod thumbs {
    use std::collections::{HashMap, VecDeque};
    use std::sync::Mutex;

    const MAX: usize = 200;

    struct Cache {
        map: HashMap<String, Option<String>>,
        order: VecDeque<String>,
    }

    static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

    pub fn get(key: &str) -> Option<Option<String>> {
        CACHE.lock().unwrap().as_ref().and_then(|c| c.map.get(key).cloned())
    }

    pub fn put(key: String, value: Option<String>) {
        let mut guard = CACHE.lock().unwrap();
        let cache = guard.get_or_insert_with(|| Cache { map: HashMap::new(), order: VecDeque::new() });
        if cache.map.insert(key.clone(), value).is_none() {
            cache.order.push_back(key);
        }
        while cache.order.len() > MAX {
            if let Some(old) = cache.order.pop_front() {
                cache.map.remove(&old);
            }
        }
    }
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};

    use ::windows::core::{HSTRING, PCWSTR};
    use ::windows::Win32::Foundation::{HANDLE, HWND, SIZE};
    use ::windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ, HPALETTE};
    use ::windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA, IWICBitmapSource,
        IWICImagingFactory, WICBitmapDitherTypeNone, WICBitmapEncoderNoCache, WICBitmapPaletteTypeCustom,
        WICBitmapUsePremultipliedAlpha, WICDecodeMetadataCacheOnDemand,
    };
    use ::windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, STATFLAG_NONAME,
        STATSTG, STREAM_SEEK_SET,
    };
    use ::windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use ::windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use ::windows::Win32::System::Ole::{CF_DIB, CF_HDROP};
    use ::windows::Win32::UI::Shell::{
        FOLDERID_Downloads, FOLDERID_Screenshots, IShellItemImageFactory, SHCreateItemFromParsingName,
        SHCreateMemStream, SHGetKnownFolderPath, ShellExecuteW, KF_FLAG_DEFAULT, SIIGBF_RESIZETOFIT,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn known_folder(id: &::windows::core::GUID) -> Option<PathBuf> {
        unsafe {
            let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
            let path = p.to_string().ok().map(PathBuf::from);
            CoTaskMemFree(Some(p.0 as *const _));
            path
        }
    }

    pub fn screenshots_dir() -> Option<PathBuf> {
        known_folder(&FOLDERID_Screenshots)
            .or_else(|| Some(crate::platform::home_dir().join("Pictures").join("Screenshots")))
    }

    pub fn downloads_dir() -> Option<PathBuf> {
        known_folder(&FOLDERID_Downloads).or_else(|| Some(crate::platform::home_dir().join("Downloads")))
    }

    pub fn open(path: &str) -> Result<(), String> {
        let file = HSTRING::from(path);
        let result = unsafe { ShellExecuteW(None, &HSTRING::from("open"), &file, None, None, SW_SHOWNORMAL) };
        // ShellExecute reports success as a value above 32.
        if result.0 as isize > 32 {
            Ok(())
        } else {
            Err("Windows could not open it".into())
        }
    }

    pub fn reveal(path: &str) -> Result<(), String> {
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn com() {
        // Already initialized on this thread (S_FALSE) or in another mode is fine.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    }

    fn wic() -> Option<IWICImagingFactory> {
        com();
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok() }
    }

    /// Any WIC source → PNG bytes, through 32 bpp BGRA.
    fn encode_png(factory: &IWICImagingFactory, source: &IWICBitmapSource) -> Option<Vec<u8>> {
        unsafe {
            let converter = factory.CreateFormatConverter().ok()?;
            converter
                .Initialize(source, &GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)
                .ok()?;
            let stream = SHCreateMemStream(None)?;
            let encoder = factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null()).ok()?;
            encoder.Initialize(&stream, WICBitmapEncoderNoCache).ok()?;
            let mut frame = None;
            let mut props = None;
            encoder.CreateNewFrame(&mut frame, &mut props).ok()?;
            let frame = frame?;
            frame.Initialize(props.as_ref()).ok()?;
            frame.WriteSource(&converter, std::ptr::null()).ok()?;
            frame.Commit().ok()?;
            encoder.Commit().ok()?;
            let mut stat = STATSTG::default();
            stream.Stat(&mut stat, STATFLAG_NONAME).ok()?;
            stream.Seek(0, STREAM_SEEK_SET, None).ok()?;
            let size = stat.cbSize as usize;
            let mut bytes = vec![0u8; size];
            let mut read = 0u32;
            stream.Read(bytes.as_mut_ptr() as *mut _, size as u32, Some(&mut read)).ok().ok()?;
            bytes.truncate(read as usize);
            Some(bytes)
        }
    }

    /// Explorer's thumbnail (images, videos, PDFs) or icon (anything else).
    pub fn thumbnail_png(path: &Path, px: i32) -> Option<Vec<u8>> {
        com();
        unsafe {
            let wide = HSTRING::from(path.as_os_str());
            let item: IShellItemImageFactory = SHCreateItemFromParsingName(&wide, None).ok()?;
            let hbm = item.GetImage(SIZE { cx: px, cy: px }, SIIGBF_RESIZETOFIT).ok()?;
            let factory = wic();
            let png = factory.as_ref().and_then(|f| {
                let bitmap = f.CreateBitmapFromHBITMAP(hbm, HPALETTE::default(), WICBitmapUsePremultipliedAlpha).ok()?;
                encode_png(f, &bitmap.into())
            });
            let _ = DeleteObject(HGDIOBJ(hbm.0));
            png
        }
    }

    /// The image as a bottom-up 32 bpp DIB, for the clipboard's CF_DIB.
    fn image_dib(path: &str) -> Option<Vec<u8>> {
        let factory = wic()?;
        unsafe {
            let decoder = factory
                .CreateDecoderFromFilename(
                    &HSTRING::from(path),
                    None,
                    ::windows::Win32::Foundation::GENERIC_READ,
                    WICDecodeMetadataCacheOnDemand,
                )
                .ok()?;
            let frame = decoder.GetFrame(0).ok()?;
            let converter = factory.CreateFormatConverter().ok()?;
            converter
                .Initialize(&frame, &GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)
                .ok()?;
            let (mut w, mut h) = (0u32, 0u32);
            converter.GetSize(&mut w, &mut h).ok()?;
            let stride = w as usize * 4;
            let mut pixels = vec![0u8; stride * h as usize];
            converter.CopyPixels(std::ptr::null(), stride as u32, &mut pixels).ok()?;
            Some(super::dib_bytes(w, h, &pixels))
        }
    }

    unsafe fn set_clipboard(format: u32, bytes: &[u8]) -> Result<(), String> {
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|e| e.message())?;
        let ptr = GlobalLock(handle) as *mut u8;
        if ptr.is_null() {
            return Err("clipboard memory".into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
        let _ = GlobalUnlock(handle);
        // The clipboard owns the memory from here.
        SetClipboardData(format, Some(HANDLE(handle.0))).map(|_| ()).map_err(|e| e.message())
    }

    pub fn copy(path: &str, is_image: bool) -> Result<(), String> {
        let files = super::dropfiles_bytes(&[path.to_string()]);
        let dib = if is_image { image_dib(path) } else { None };
        unsafe {
            OpenClipboard(Some(HWND::default())).map_err(|e| e.message())?;
            let result = (|| {
                EmptyClipboard().map_err(|e| e.message())?;
                set_clipboard(CF_HDROP.0 as u32, &files)?;
                if let Some(dib) = dib {
                    set_clipboard(CF_DIB.0 as u32, &dib)?;
                }
                Ok(())
            })();
            let _ = CloseClipboard();
            result
        }
    }

    #[allow(dead_code)]
    fn _unused(_: PCWSTR) {}
}

#[cfg(not(windows))]
mod imp {
    use std::path::{Path, PathBuf};

    pub fn screenshots_dir() -> Option<PathBuf> {
        Some(crate::platform::home_dir().join("Pictures").join("Screenshots"))
    }

    pub fn downloads_dir() -> Option<PathBuf> {
        Some(crate::platform::home_dir().join("Downloads"))
    }

    pub fn open(path: &str) -> Result<(), String> {
        std::process::Command::new("xdg-open").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn reveal(path: &str) -> Result<(), String> {
        let dir = Path::new(path).parent().unwrap_or(Path::new("/"));
        std::process::Command::new("xdg-open").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn copy(_path: &str, _is_image: bool) -> Result<(), String> {
        Err("Copying files is Windows only for now".into())
    }

    pub fn thumbnail_png(_path: &Path, _px: i32) -> Option<Vec<u8>> {
        None
    }
}

/// BITMAPINFOHEADER (40 bytes, BI_RGB, 32 bpp) then the rows bottom-up, as
/// CF_DIB wants. `top_down` is `w * h` BGRA pixels, first row first.
pub(crate) fn dib_bytes(w: u32, h: u32, top_down: &[u8]) -> Vec<u8> {
    let stride = w as usize * 4;
    let mut out = Vec::with_capacity(40 + top_down.len());
    out.extend_from_slice(&40u32.to_le_bytes()); // biSize
    out.extend_from_slice(&(w as i32).to_le_bytes()); // biWidth
    out.extend_from_slice(&(h as i32).to_le_bytes()); // biHeight > 0: bottom-up
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    out.extend_from_slice(&((stride * h as usize) as u32).to_le_bytes()); // biSizeImage
    out.extend_from_slice(&[0u8; 16]); // resolution, colours used/important
    for row in top_down.chunks(stride.max(1)).rev() {
        out.extend_from_slice(row);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(path: &str, modified: i64) -> Entry {
        Entry { path: PathBuf::from(path), size: 10, modified, is_dir: false, hidden: false }
    }

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn kinds_by_extension() {
        assert_eq!(kind_of("Screenshot 2026-10-06.png", false), "image");
        assert_eq!(kind_of("clip.MP4", false), "video");
        assert_eq!(kind_of("invoice.pdf", false), "doc");
        assert_eq!(kind_of("build.zip", false), "archive");
        assert_eq!(kind_of("setup.exe", false), "app");
        assert_eq!(kind_of("main.rs", false), "code");
        assert_eq!(kind_of("README", false), "other");
        assert_eq!(kind_of("Project", true), "folder");
    }

    #[test]
    fn partial_and_system_files() {
        for name in ["movie.mkv.crdownload", "a.part", "x.tmp", "b.opdownload", "desktop.ini", "Thumbs.db", "~$report.docx", ".DS_Store"] {
            assert!(is_partial_or_system(name), "{name}");
        }
        for name in ["report.docx", "part.png", "tmp.txt"] {
            assert!(!is_partial_or_system(name), "{name}");
        }
    }

    #[test]
    fn recent_is_newest_first_and_bounded() {
        let entries = vec![
            e(r"C:\D\old.png", NOW - RECENT_MS - 1),
            e(r"C:\D\b.png", NOW - 2_000),
            e(r"C:\D\a.png", NOW - 1_000),
            e(r"C:\D\half.zip.crdownload", NOW),
            e(r"C:\D\future.png", NOW + 10 * 60_000),
            Entry { is_dir: true, ..e(r"C:\D\folder", NOW) },
            Entry { hidden: true, ..e(r"C:\D\hidden.png", NOW) },
        ];
        let names: Vec<String> = pick_recent(&entries, NOW).into_iter().map(|i| i.name).collect();
        assert_eq!(names, vec!["a.png", "b.png"]);
        let many: Vec<Entry> = (0..30).map(|i| e(&format!(r"C:\D\{i}.png"), NOW - i)).collect();
        let picked = pick_recent(&many, NOW);
        assert_eq!(picked.len(), RECENT_MAX);
        assert_eq!(picked[0].name, "0.png");
    }

    #[test]
    fn items_carry_what_the_card_needs() {
        let i = &pick_recent(&[e(r"C:\D\shot.png", NOW)], NOW)[0];
        assert_eq!(i.path, r"C:\D\shot.png");
        assert_eq!((i.kind, i.size, i.modified), ("image", 10, NOW));
        let json = serde_json::to_value(i).unwrap();
        assert_eq!(json["modified"], NOW);
        assert_eq!(json["kind"], "image");
    }

    #[test]
    fn pins_go_first_without_duplicates() {
        let mut list = vec![r"C:\a.txt".to_string(), r"C:\b.txt".to_string()];
        pin(&mut list, &[r"C:\c.txt".into(), r"c:\A.TXT".into()]);
        // The drop's order is kept at the front; the old A is not kept twice.
        assert_eq!(list.len(), 3);
        assert_eq!(list[0], r"C:\c.txt");
        assert!(same_path(&list[1], r"C:\a.txt"));
        assert_eq!(list[2], r"C:\b.txt");
        unpin(&mut list, r"C:\C.TXT");
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn pins_are_bounded() {
        let mut list = Vec::new();
        for i in 0..PINNED_MAX + 5 {
            pin(&mut list, &[format!(r"C:\{i}.txt")]);
        }
        assert_eq!(list.len(), PINNED_MAX);
        assert_eq!(list[0], format!(r"C:\{}.txt", PINNED_MAX + 4));
    }

    #[test]
    fn pins_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("coucou-shelf-test-{}", std::process::id()));
        let path = dir.join("shelf.json");
        let list = vec![r"C:\a b\c.png".to_string()];
        save_pins(&path, &list).unwrap();
        assert_eq!(load_pins(&path), list);
        std::fs::write(&path, b"nope").unwrap();
        assert!(load_pins(&path).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_shown_paths_are_allowed() {
        let snap = Snapshot {
            pinned: pick_recent(&[e(r"C:\Pinned\a.png", NOW)], NOW),
            screenshots: pick_recent(&[e(r"C:\Shots\s.png", NOW)], NOW),
            downloads: vec![],
        };
        assert!(allowed(&snap, r"C:\Pinned\a.png"));
        assert!(allowed(&snap, r"c:\shots\S.PNG"));
        assert!(!allowed(&snap, r"C:\Windows\System32\cmd.exe"));
        assert!(!allowed(&Snapshot::default(), r"C:\Pinned\a.png"));
    }

    #[test]
    fn dropfiles_layout() {
        let bytes = dropfiles_bytes(&[r"C:\a.png".into(), "D:\\é.txt".into()]);
        assert_eq!(&bytes[0..4], &20u32.to_le_bytes());
        assert_eq!(&bytes[16..20], &1i32.to_le_bytes(), "wide names");
        let names: Vec<u16> = bytes[20..].chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let text = String::from_utf16(&names).unwrap();
        assert_eq!(text, "C:\\a.png\0D:\\é.txt\0\0");
    }

    #[test]
    fn dib_is_bottom_up_with_a_header() {
        // 1×2: a red row on top of a blue row.
        let top_down = [0, 0, 255, 255, 255, 0, 0, 255];
        let dib = dib_bytes(1, 2, &top_down);
        assert_eq!(dib.len(), 40 + 8);
        assert_eq!(&dib[0..4], &40u32.to_le_bytes());
        assert_eq!(&dib[8..12], &2i32.to_le_bytes());
        assert_eq!(&dib[14..16], &32u16.to_le_bytes());
        // Bottom row (blue) first.
        assert_eq!(&dib[40..44], &[255, 0, 0, 255]);
        assert_eq!(&dib[44..48], &[0, 0, 255, 255]);
    }

    /// Live eval: thumbnails from several threads at once, as the card asks
    /// for them (three at a time), many rounds. A crash here is a crash in the app.
    #[test]
    #[ignore]
    fn shelf_thumbs_parallel_live() {
        let snap = snapshot();
        let paths: Vec<String> = snap.all().map(|i| i.path.clone()).collect();
        assert!(!paths.is_empty(), "nothing to thumbnail");
        let handles: Vec<_> = (0..6)
            .map(|t| {
                let paths = paths.clone();
                std::thread::spawn(move || {
                    let mut ok = 0;
                    for round in 0..5 {
                        for (i, p) in paths.iter().enumerate() {
                            if (i + t + round) % 2 == 0 && imp::thumbnail_png(Path::new(p), THUMB_PX).is_some() {
                                ok += 1;
                            }
                        }
                    }
                    ok
                })
            })
            .collect();
        let ok: usize = handles.into_iter().map(|h| h.join().expect("thread")).sum();
        println!("shelf_thumbs_parallel_live: {ok} thumbnails across 6 threads");
        assert!(ok > 0);
    }

    /// Live eval: the folders resolve and a thumbnail comes back as a PNG.
    /// Prints counts only, never file names.
    #[test]
    #[ignore]
    fn shelf_live() {
        let snap = snapshot();
        println!(
            "shelf_live: pinned={} screenshots={} downloads={} dirs={:?}/{:?}",
            snap.pinned.len(),
            snap.screenshots.len(),
            snap.downloads.len(),
            imp::screenshots_dir().map(|d| d.exists()),
            imp::downloads_dir().map(|d| d.exists())
        );
        let total = snap.all().count();
        let ok = snap.all().filter(|i| imp::thumbnail_png(Path::new(&i.path), THUMB_PX).is_some()).count();
        println!("shelf_live: thumbnails {ok}/{total}");
        let any = snap.all().next().map(|i| i.path.clone());
        // Fall back to a file that always exists.
        let target = any.unwrap_or_else(|| std::env::current_exe().unwrap().to_string_lossy().into_owned());
        let png = imp::thumbnail_png(Path::new(&target), THUMB_PX).expect("thumbnail");
        println!("shelf_live: thumbnail bytes={}", png.len());
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
    }
}
