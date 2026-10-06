// What is playing, through the Windows media session (the same source as the
// volume flyout and the lock screen): Spotify, a browser tab, any app that
// registers with System Media Transport Controls. Nothing is polled when the
// caller doesn't ask, and titles never reach the log.
//
// Everything that decides something (which session, which label, which
// action) is a pure function below so it is tested on every platform; the
// WinRT calls live in `imp` and only gather facts.


use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub app: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub can_next: bool,
    pub can_prev: bool,
    pub can_play_pause: bool,
    /// Song length; 0 when the player does not say.
    pub duration_ms: u64,
    /// Where the song was at `position_at_ms` (unix ms). The island moves it
    /// forward itself while playing, so the poll does not have to.
    pub position_ms: u64,
    pub position_at_ms: i64,
    /// Changes whenever the cover changes; 0 = none. The image itself is
    /// fetched with `art()`, so a 40 KB data URL is not resent every poll.
    pub art_id: u32,
}

/// Window FILETIME ticks (100 ns since 1601) → unix ms. None for the zero
/// date players leave in a field they never set.
pub(crate) fn filetime_to_unix_ms(ticks: i64) -> Option<i64> {
    const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;
    (ticks > UNIX_EPOCH_TICKS).then(|| (ticks - UNIX_EPOCH_TICKS) / 10_000)
}

/// A pause shorter than this between two polls is the player re-reporting
/// its position, not a seek: not worth rebuilding the card for.
const DRIFT_MS: i64 = 1_500;

/// Whether `b` shows the same thing as `a`. Everything but the timeline must
/// match exactly; the timeline only has to agree on where the song started
/// (playing) or where it stopped (paused), give or take DRIFT_MS.
pub(crate) fn same_media(a: &MediaInfo, b: &MediaInfo) -> bool {
    let rest_equal = a.app == b.app
        && a.title == b.title
        && a.artist == b.artist
        && a.album == b.album
        && a.playing == b.playing
        && a.can_next == b.can_next
        && a.can_prev == b.can_prev
        && a.can_play_pause == b.can_play_pause
        && a.duration_ms == b.duration_ms
        && a.art_id == b.art_id;
    if !rest_equal {
        return false;
    }
    let anchor = |m: &MediaInfo| {
        if m.playing {
            m.position_at_ms - m.position_ms as i64
        } else {
            m.position_ms as i64
        }
    };
    (anchor(a) - anchor(b)).abs() < DRIFT_MS
}

/// The MIME type of a cover: the stream's own when it gives one, else sniffed
/// from the first bytes. None for anything an <img> should not be fed.
pub(crate) fn image_mime(bytes: &[u8], content_type: &str) -> Option<&'static str> {
    let sniffed = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    };
    // The bytes win over a wrong or empty content type.
    sniffed.or(match content_type.to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        _ => None,
    })
}

/// Covers larger than this are not a thumbnail: skipped.
pub(crate) const ART_MAX_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn data_url(bytes: &[u8], content_type: &str) -> Option<String> {
    use base64::Engine as _;
    if bytes.is_empty() || bytes.len() > ART_MAX_BYTES {
        return None;
    }
    let mime = image_mime(bytes, content_type)?;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Polls that read the cover again after a track change. Spotify swaps the
/// thumbnail a moment after the title, so the first read can still be the
/// previous song's cover.
const ART_READS: u8 = 3;

/// Which cover the card shows, and when to read it again.
#[derive(Debug, Default)]
pub(crate) struct ArtCache {
    key: String,
    reads: u8,
    hash: Option<u64>,
    url: Option<String>,
    id: u32,
}

impl ArtCache {
    pub fn wants_read(&self, key: &str) -> bool {
        key != self.key || self.reads < ART_READS
    }

    /// Records one read for `key`: `cover` is (bytes, content type), or None
    /// when the player had nothing (yet).
    pub fn store(&mut self, key: &str, cover: Option<(&[u8], &str)>) {
        if key != self.key {
            self.key = key.to_string();
            self.reads = 0;
            self.hash = None;
            self.url = None;
        }
        self.reads = self.reads.saturating_add(1);
        let Some((bytes, content_type)) = cover else { return };
        let hash = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            bytes.hash(&mut h);
            h.finish()
        };
        if self.hash == Some(hash) {
            return;
        }
        if let Some(url) = data_url(bytes, content_type) {
            self.hash = Some(hash);
            self.url = Some(url);
            // Never 0, which means "no cover".
            self.id = self.id.wrapping_add(1).max(1);
        }
    }

    pub fn id(&self) -> u32 {
        if self.url.is_some() { self.id } else { 0 }
    }

    pub fn current(&self) -> Option<(u32, String)> {
        self.url.clone().map(|u| (self.id, u))
    }
}

/// The facts `pick` needs about one session, without any WinRT type in it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Candidate {
    pub aumid: String,
    pub has_title: bool,
    pub playing: bool,
    pub is_current: bool,
}

/// Index of the session to show and control. A session without a title has
/// nothing to show (a paused tab that never started, a call app), so it never
/// wins. Then: playing beats paused, Spotify beats other players in the same
/// state, Windows' own "current" session breaks the remaining tie, and the
/// first one listed is the last resort.
pub(crate) fn pick(candidates: &[Candidate]) -> Option<usize> {
    candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| c.has_title)
        // max_by_key keeps the last maximum; reversing the order of a tie
        // with the negated index makes the earliest one win instead.
        .max_by_key(|(i, c)| (c.playing, is_spotify(&c.aumid), c.is_current, std::cmp::Reverse(*i)))
        .map(|(i, _)| i)
}

fn is_spotify(aumid: &str) -> bool {
    aumid.to_ascii_lowercase().contains("spotify")
}

/// A name a person recognises from the session's AppUserModelId:
/// "Spotify.exe" → "Spotify", "MSEdge" → "Edge",
/// "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" → "Microsoft.ZuneMusic".
pub(crate) fn app_label(aumid: &str) -> String {
    let lower = aumid.to_ascii_lowercase();
    // Browsers register under hashes or long package ids, so look for the
    // name anywhere rather than at the start.
    const KNOWN: &[(&str, &str)] = &[
        ("spotify", "Spotify"),
        ("msedge", "Edge"),
        ("microsoftedge", "Edge"),
        ("chrome", "Chrome"),
        ("firefox", "Firefox"),
        // Firefox's per-install AUMID is this hash of its install path.
        ("308046b0af4a39cb", "Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("vlc", "VLC"),
    ];
    if let Some((_, label)) = KNOWN.iter().find(|(needle, _)| lower.contains(needle)) {
        return (*label).to_string();
    }
    let mut name = aumid.trim();
    // Win32 apps sometimes register a full path.
    if let Some(i) = name.rfind(['\\', '/']) {
        name = &name[i + 1..];
    }
    // Packaged apps: "Package.Name_publisherhash!AppId" → "Package.Name".
    if name.contains('!') {
        name = name.split('!').next().unwrap_or(name);
        if let Some(i) = name.rfind('_') {
            name = &name[..i];
        }
    }
    if name.len() > 4 && name[name.len() - 4..].eq_ignore_ascii_case(".exe") {
        name = &name[..name.len() - 4];
    }
    if name.is_empty() {
        "Media".to_string()
    } else {
        name.to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    PlayPause,
    Next,
    Prev,
}

pub(crate) fn parse_action(action: &str) -> Result<Action, String> {
    match action {
        "play_pause" => Ok(Action::PlayPause),
        "next" => Ok(Action::Next),
        "prev" => Ok(Action::Prev),
        other => Err(format!("unknown media action {other:?}")),
    }
}

#[cfg(windows)]
pub use imp::{art, control, snapshot};

#[cfg(not(windows))]
pub fn snapshot() -> Result<Option<MediaInfo>, String> {
    Ok(None)
}

#[cfg(not(windows))]
pub fn art() -> Option<(u32, String)> {
    None
}

#[cfg(not(windows))]
pub fn control(action: &str) -> Result<(), String> {
    parse_action(action)?;
    Err("not supported".into())
}

#[cfg(windows)]
mod imp {
    use ::windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionMediaProperties as Properties,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };

    use std::sync::Mutex;

    use ::windows::Storage::Streams::DataReader;

    use super::{
        app_label, filetime_to_unix_ms, parse_action, pick, Action, ArtCache, Candidate, MediaInfo, ART_MAX_BYTES,
    };

    fn err(what: &str, e: ::windows::core::Error) -> String {
        format!("{what}: {}", e.message())
    }

    /// The session `pick` chose, with what was read to choose it.
    struct Chosen {
        session: Session,
        aumid: String,
        properties: Properties,
        playing: bool,
    }

    // Every `.get()` below blocks the calling thread until WinRT answers.
    // That is why the public functions must run in spawn_blocking (an MTA
    // worker), never on the UI thread, which is an STA where a blocking wait
    // on an async operation can deadlock.
    fn choose() -> Result<Option<Chosen>, String> {
        let manager = Manager::RequestAsync()
            .and_then(|op| op.get())
            .map_err(|e| err("media sessions unavailable", e))?;
        let current = manager
            .GetCurrentSession()
            .ok()
            .and_then(|s| s.SourceAppUserModelId().ok())
            .map(|id| id.to_string());
        let sessions = manager.GetSessions().map_err(|e| err("media sessions", e))?;

        let mut gathered: Vec<(Session, Properties)> = Vec::new();
        let mut candidates: Vec<Candidate> = Vec::new();
        for session in sessions {
            // A session that vanished between the list and the read (the tab
            // closed) is simply skipped.
            let Ok(aumid) = session.SourceAppUserModelId().map(|s| s.to_string()) else {
                continue;
            };
            let Ok(properties) = session.TryGetMediaPropertiesAsync().and_then(|op| op.get()) else {
                continue;
            };
            let has_title = properties.Title().map(|t| !t.is_empty()).unwrap_or(false);
            let playing = session
                .GetPlaybackInfo()
                .and_then(|info| info.PlaybackStatus())
                .map(|s| s == Status::Playing)
                .unwrap_or(false);
            candidates.push(Candidate {
                is_current: current.as_deref() == Some(aumid.as_str()),
                aumid,
                has_title,
                playing,
            });
            gathered.push((session, properties));
        }

        let Some(i) = pick(&candidates) else {
            return Ok(None);
        };
        let (session, properties) = gathered.swap_remove(i);
        let candidate = candidates.swap_remove(i);
        Ok(Some(Chosen { session, aumid: candidate.aumid, properties, playing: candidate.playing }))
    }

    /// Blocking (WinRT .get()); the caller runs it in spawn_blocking.
    pub fn snapshot() -> Result<Option<MediaInfo>, String> {
        let Some(chosen) = choose()? else {
            return Ok(None);
        };
        let controls = chosen.session.GetPlaybackInfo().and_then(|info| info.Controls()).ok();
        let flag = |read: fn(
            &::windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackControls,
        ) -> ::windows::core::Result<bool>| {
            controls.as_ref().and_then(|c| read(c).ok()).unwrap_or(false)
        };
        let p = &chosen.properties;
        let title = p.Title().map(|s| s.to_string()).unwrap_or_default();
        let artist = p.Artist().map(|s| s.to_string()).unwrap_or_default();
        let album = p.AlbumTitle().map(|s| s.to_string()).unwrap_or_default();

        // Position is where the song was when the player last reported it;
        // the island carries it forward from position_at_ms.
        let now = now_ms();
        let (duration_ms, position_ms, position_at_ms) = match chosen.session.GetTimelineProperties() {
            Ok(t) => {
                let ticks = |r: ::windows::core::Result<::windows::Foundation::TimeSpan>| {
                    r.map(|s| s.Duration.max(0) / 10_000).unwrap_or(0) as u64
                };
                let start = ticks(t.StartTime());
                let end = ticks(t.EndTime());
                let position = ticks(t.Position()).saturating_sub(start);
                let at = t
                    .LastUpdatedTime()
                    .ok()
                    .and_then(|d| filetime_to_unix_ms(d.UniversalTime))
                    // A stamp in the future is a clock the player got wrong.
                    .filter(|at| *at <= now)
                    .unwrap_or(now);
                (end.saturating_sub(start), position, at)
            }
            Err(_) => (0, 0, now),
        };

        let key = format!("{}\u{1f}{title}\u{1f}{artist}\u{1f}{album}", chosen.aumid);
        let art_id = {
            let mut cache = ART.lock().unwrap();
            if cache.wants_read(&key) {
                let cover = read_cover(p);
                cache.store(&key, cover.as_ref().map(|(b, ct)| (b.as_slice(), ct.as_str())));
            }
            cache.id()
        };

        Ok(Some(MediaInfo {
            app: app_label(&chosen.aumid),
            title,
            artist,
            album,
            playing: chosen.playing,
            can_next: flag(|c| c.IsNextEnabled()),
            can_prev: flag(|c| c.IsPreviousEnabled()),
            can_play_pause: flag(|c| c.IsPlayPauseToggleEnabled())
                || flag(|c| c.IsPlayEnabled())
                || flag(|c| c.IsPauseEnabled()),
            duration_ms,
            position_ms,
            position_at_ms,
            art_id,
        }))
    }

    static ART: Mutex<ArtCache> = Mutex::new(ArtCache { key: String::new(), reads: 0, hash: None, url: None, id: 0 });

    /// The cover snapshot() last read, as (art_id, data URL).
    pub fn art() -> Option<(u32, String)> {
        ART.lock().unwrap().current()
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// The cover's bytes and content type. Blocking, like the rest of imp.
    fn read_cover(p: &Properties) -> Option<(Vec<u8>, String)> {
        let reference = p.Thumbnail().ok()?;
        let stream = reference.OpenReadAsync().ok()?.get().ok()?;
        let size = stream.Size().ok()? as usize;
        if size == 0 || size > ART_MAX_BYTES {
            return None;
        }
        let reader = DataReader::CreateDataReader(&stream).ok()?;
        let loaded = reader.LoadAsync(size as u32).ok()?.get().ok()? as usize;
        let mut bytes = vec![0u8; loaded];
        reader.ReadBytes(&mut bytes).ok()?;
        let content_type = stream.ContentType().map(|s| s.to_string()).unwrap_or_default();
        Some((bytes, content_type))
    }

    /// "play_pause" | "next" | "prev" on the same session snapshot() would pick.
    pub fn control(action: &str) -> Result<(), String> {
        let action = parse_action(action)?;
        let Some(chosen) = choose()? else {
            return Err("nothing is playing".into());
        };
        let s = &chosen.session;
        let op = match action {
            Action::Next => s.TrySkipNextAsync(),
            Action::Prev => s.TrySkipPreviousAsync(),
            Action::PlayPause => {
                // Some players expose Play and Pause but not the toggle.
                let toggle = s
                    .GetPlaybackInfo()
                    .and_then(|i| i.Controls())
                    .and_then(|c| c.IsPlayPauseToggleEnabled())
                    .unwrap_or(true);
                if toggle {
                    s.TryTogglePlayPauseAsync()
                } else if chosen.playing {
                    s.TryPauseAsync()
                } else {
                    s.TryPlayAsync()
                }
            }
        };
        let accepted = op.and_then(|op| op.get()).map_err(|e| err("media control", e))?;
        if accepted {
            Ok(())
        } else {
            Err(format!("{} refused the command", app_label(&chosen.aumid)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(aumid: &str, has_title: bool, playing: bool, is_current: bool) -> Candidate {
        Candidate { aumid: aumid.into(), has_title, playing, is_current }
    }

    #[test]
    fn pick_nothing_from_nothing() {
        assert_eq!(pick(&[]), None);
    }

    #[test]
    fn pick_skips_sessions_without_title() {
        assert_eq!(pick(&[c("Spotify.exe", false, true, true)]), None);
        assert_eq!(pick(&[c("Spotify.exe", false, true, true), c("Chrome", true, false, false)]), Some(1));
    }

    #[test]
    fn pick_prefers_playing_over_spotify_and_current() {
        let list = [c("Spotify.exe", true, false, true), c("MSEdge", true, true, false)];
        assert_eq!(pick(&list), Some(1));
    }

    #[test]
    fn pick_prefers_spotify_among_playing() {
        let list = [c("Chrome", true, true, true), c("Spotify.exe", true, true, false)];
        assert_eq!(pick(&list), Some(1));
    }

    #[test]
    fn pick_prefers_spotify_among_paused() {
        let list = [c("Chrome", true, false, true), c("Spotify.exe", true, false, false)];
        assert_eq!(pick(&list), Some(1));
    }

    #[test]
    fn pick_falls_back_to_current_then_first() {
        let list = [c("Chrome", true, false, false), c("MSEdge", true, false, true)];
        assert_eq!(pick(&list), Some(1));
        let list = [c("Chrome", true, false, false), c("MSEdge", true, false, false)];
        assert_eq!(pick(&list), Some(0));
        let list = [c("Chrome", true, true, false), c("MSEdge", true, true, false)];
        assert_eq!(pick(&list), Some(0));
    }

    #[test]
    fn labels_for_known_apps() {
        assert_eq!(app_label("Spotify.exe"), "Spotify");
        assert_eq!(app_label("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(app_label("Chrome"), "Chrome");
        assert_eq!(app_label("chrome.exe"), "Chrome");
        assert_eq!(app_label("MSEdge"), "Edge");
        assert_eq!(app_label("Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe!App"), "Edge");
        assert_eq!(app_label("308046B0AF4A39CB"), "Firefox");
        assert_eq!(app_label("firefox.exe"), "Firefox");
    }

    #[test]
    fn labels_for_unknown_apps() {
        assert_eq!(app_label("foobar2000.exe"), "foobar2000");
        assert_eq!(app_label("Foo.EXE"), "Foo");
        assert_eq!(app_label("F0DC299D809B9700"), "F0DC299D809B9700");
        assert_eq!(app_label("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Microsoft.ZuneMusic");
        assert_eq!(app_label(r"C:\Program Files\Tool\player.exe"), "player");
        assert_eq!(app_label(""), "Media");
        assert_eq!(app_label(".exe"), ".exe");
    }

    #[test]
    fn actions() {
        assert_eq!(parse_action("play_pause"), Ok(Action::PlayPause));
        assert_eq!(parse_action("next"), Ok(Action::Next));
        assert_eq!(parse_action("prev"), Ok(Action::Prev));
        assert!(parse_action("stop").is_err());
        assert!(parse_action("").is_err());
    }

    fn info() -> MediaInfo {
        MediaInfo {
            app: "Spotify".into(),
            title: "t".into(),
            artist: "a".into(),
            album: "al".into(),
            playing: true,
            can_next: true,
            can_prev: false,
            can_play_pause: true,
            duration_ms: 161_000,
            position_ms: 10_000,
            position_at_ms: 1_000_000,
            art_id: 1,
        }
    }

    #[test]
    fn media_info_serializes_camel_case() {
        let json = serde_json::to_value(info()).unwrap();
        assert_eq!(json["canNext"], true);
        assert_eq!(json["canPrev"], false);
        assert_eq!(json["canPlayPause"], true);
        assert_eq!(json["durationMs"], 161_000);
        assert_eq!(json["positionMs"], 10_000);
        assert_eq!(json["positionAtMs"], 1_000_000);
        assert_eq!(json["artId"], 1);
        assert_eq!(json["album"], "al");
    }

    #[test]
    fn filetime_conversion() {
        // 2024-01-01T00:00:00Z.
        assert_eq!(filetime_to_unix_ms(133_485_408_000_000_000), Some(1_704_067_200_000));
        assert_eq!(filetime_to_unix_ms(116_444_736_000_000_000 + 10_000), Some(1));
        assert_eq!(filetime_to_unix_ms(0), None);
        assert_eq!(filetime_to_unix_ms(116_444_736_000_000_000), None);
        assert_eq!(filetime_to_unix_ms(-5), None);
    }

    #[test]
    fn same_media_tolerates_a_re_reported_position() {
        let a = info();
        // Two seconds later the player reports two seconds further: same song, same pace.
        let b = MediaInfo { position_ms: 12_000, position_at_ms: 1_002_000, ..info() };
        assert!(same_media(&a, &b));
        // Slightly off is still the same.
        let b = MediaInfo { position_ms: 12_900, position_at_ms: 1_002_000, ..info() };
        assert!(same_media(&a, &b));
        // A seek is not.
        let b = MediaInfo { position_ms: 60_000, position_at_ms: 1_002_000, ..info() };
        assert!(!same_media(&a, &b));
    }

    #[test]
    fn same_media_paused_compares_the_position() {
        let a = MediaInfo { playing: false, ..info() };
        // Paused: the sample time moving on means nothing.
        let b = MediaInfo { playing: false, position_at_ms: 9_000_000, ..info() };
        assert!(same_media(&a, &b));
        let b = MediaInfo { playing: false, position_ms: 20_000, ..info() };
        assert!(!same_media(&a, &b));
    }

    #[test]
    fn same_media_sees_every_other_change() {
        let a = info();
        assert!(!same_media(&a, &MediaInfo { title: "u".into(), ..info() }));
        assert!(!same_media(&a, &MediaInfo { album: "x".into(), ..info() }));
        assert!(!same_media(&a, &MediaInfo { playing: false, ..info() }));
        assert!(!same_media(&a, &MediaInfo { art_id: 2, ..info() }));
        assert!(!same_media(&a, &MediaInfo { duration_ms: 1, ..info() }));
        assert!(!same_media(&a, &MediaInfo { can_next: false, ..info() }));
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10];

    #[test]
    fn image_types() {
        assert_eq!(image_mime(PNG, ""), Some("image/png"));
        assert_eq!(image_mime(JPEG, ""), Some("image/jpeg"));
        // The bytes win over a wrong header.
        assert_eq!(image_mime(JPEG, "image/png"), Some("image/jpeg"));
        assert_eq!(image_mime(b"GIF89a....", ""), Some("image/gif"));
        assert_eq!(image_mime(b"RIFF\0\0\0\0WEBPVP8 ", ""), Some("image/webp"));
        assert_eq!(image_mime(b"????", "image/jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime(b"<svg onload=x>", "image/svg+xml"), None);
        assert_eq!(image_mime(b"", ""), None);
    }

    #[test]
    fn data_urls() {
        assert_eq!(data_url(PNG, "").unwrap(), "data:image/png;base64,iVBORw0KGgoAAA==");
        assert_eq!(data_url(b"", "image/png"), None);
        assert_eq!(data_url(b"not an image", ""), None);
        let huge = [JPEG, &vec![0u8; ART_MAX_BYTES]].concat();
        assert_eq!(data_url(&huge, ""), None);
    }

    #[test]
    fn art_cache_follows_the_track() {
        let mut cache = ArtCache::default();
        assert!(cache.wants_read("song1"));
        cache.store("song1", Some((PNG, "")));
        assert_eq!(cache.id(), 1);
        // Read again for a few polls, then left alone.
        assert!(cache.wants_read("song1"));
        cache.store("song1", Some((PNG, "")));
        cache.store("song1", Some((PNG, "")));
        assert_eq!(cache.id(), 1, "the same bytes keep the same id");
        assert!(!cache.wants_read("song1"));

        // A new song with no cover yet: none, then its cover arrives.
        assert!(cache.wants_read("song2"));
        cache.store("song2", None);
        assert_eq!(cache.id(), 0);
        assert_eq!(cache.current(), None);
        cache.store("song2", Some((JPEG, "")));
        assert_eq!(cache.id(), 2);
        assert!(cache.current().unwrap().1.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn art_cache_replaces_a_stale_cover() {
        let mut cache = ArtCache::default();
        cache.store("song1", Some((PNG, "")));
        // The new title arrives with the old cover, the right one a poll later.
        cache.store("song2", Some((PNG, "")));
        let stale = cache.id();
        assert_ne!(stale, 0);
        cache.store("song2", Some((JPEG, "")));
        assert_ne!(cache.id(), stale);
        assert!(cache.current().unwrap().1.contains("image/jpeg"));
    }

    #[test]
    fn art_cache_ignores_garbage() {
        let mut cache = ArtCache::default();
        cache.store("song1", Some((b"garbage", "")));
        assert_eq!(cache.id(), 0);
    }

    /// Live eval against this machine's media sessions. Prints only the app
    /// label and the playing state, never the title or artist.
    #[test]
    #[ignore]
    fn media_live() {
        match snapshot() {
            Ok(Some(info)) => {
                println!(
                    "media_live: session found app={} playing={} next={} prev={} play_pause={} title_present={} album_present={} duration_ms={} position_ms={} sampled_ms_ago={} art_id={}",
                    info.app,
                    info.playing,
                    info.can_next,
                    info.can_prev,
                    info.can_play_pause,
                    !info.title.is_empty(),
                    !info.album.is_empty(),
                    info.duration_ms,
                    info.position_ms,
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0)
                        - info.position_at_ms,
                    info.art_id
                );
                if let Some((id, url)) = art() {
                    println!("media_live: art id={id} bytes_b64={} head={}", url.len(), &url[..url.find(',').unwrap_or(0)]);
                }
            }
            Ok(None) => println!("media_live: no session with a title"),
            Err(e) => panic!("media_live: {e}"),
        }
    }
}
