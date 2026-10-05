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
    pub playing: bool,
    pub can_next: bool,
    pub can_prev: bool,
    pub can_play_pause: bool,
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
pub use imp::{control, snapshot};

#[cfg(not(windows))]
pub fn snapshot() -> Result<Option<MediaInfo>, String> {
    Ok(None)
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

    use super::{app_label, parse_action, pick, Action, Candidate, MediaInfo};

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
        Ok(Some(MediaInfo {
            app: app_label(&chosen.aumid),
            title: chosen.properties.Title().map(|s| s.to_string()).unwrap_or_default(),
            artist: chosen.properties.Artist().map(|s| s.to_string()).unwrap_or_default(),
            playing: chosen.playing,
            can_next: flag(|c| c.IsNextEnabled()),
            can_prev: flag(|c| c.IsPreviousEnabled()),
            can_play_pause: flag(|c| c.IsPlayPauseToggleEnabled())
                || flag(|c| c.IsPlayEnabled())
                || flag(|c| c.IsPauseEnabled()),
        }))
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

    #[test]
    fn media_info_serializes_camel_case() {
        let info = MediaInfo {
            app: "Spotify".into(),
            title: "t".into(),
            artist: "a".into(),
            playing: true,
            can_next: true,
            can_prev: false,
            can_play_pause: true,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["canNext"], true);
        assert_eq!(json["canPrev"], false);
        assert_eq!(json["canPlayPause"], true);
    }

    /// Live eval against this machine's media sessions. Prints only the app
    /// label and the playing state, never the title or artist.
    #[test]
    #[ignore]
    fn media_live() {
        match snapshot() {
            Ok(Some(info)) => println!(
                "media_live: session found app={} playing={} next={} prev={} play_pause={} title_present={}",
                info.app,
                info.playing,
                info.can_next,
                info.can_prev,
                info.can_play_pause,
                !info.title.is_empty()
            ),
            Ok(None) => println!("media_live: no session with a title"),
            Err(e) => panic!("media_live: {e}"),
        }
    }
}
