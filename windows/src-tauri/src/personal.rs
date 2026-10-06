// Pollers for this build's own pills: Claude usage, Space, music, messages.
//
// Same pipe as the stock integrations (integrations.rs): each emits an
// `integration` event and the island owns badges, sounds and cards. None of
// them needs a key or reaches a service the user did not already use: the
// status files are local, Space goes through the user's own MCP server, and
// music and messages come from Windows itself. The one exception is lyrics:
// the playing song's title and artist go to lrclib.net, only while the Lyrics
// preference is on (Settings → Music).
//
// Message text and song titles are never logged.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::integrations::{emit, spawn, IntegrationEvent, IntegrationUpdate};
use crate::{audio, log, lyrics, media, notify, quota, shelf, space};

/// Messages kept for the card. In memory only: they die with the app.
const MESSAGE_HISTORY: usize = 15;

pub fn start(app: AppHandle) {
    spawn(app.clone(), "integration_quota", 2, 5, poll_quota);
    spawn(app.clone(), "integration_media", 2, 2, poll_media);
    spawn(app.clone(), "integration_messages", 3, 3, poll_messages);
    spawn(app.clone(), "integration_shelf", 3, 3, poll_shelf);
    spawn(app.clone(), "integration_audio", 2, 2, poll_audio);
    // Starting uv + Python costs ~3 s: five minutes is plenty for a day plan.
    spawn(app, "integration_space", 4, 300, poll_space);
}

/// One-shot refresh; false when `id` is not a personal pill. A refresh
/// always reaches the island, even when nothing changed since the last poll
/// (the island may have reloaded and lost what it had).
pub async fn poll_once(app: AppHandle, id: &str) -> bool {
    match id {
        "integration_media" => *LAST_MEDIA.lock().unwrap() = None,
        "integration_shelf" => *LAST_SHELF.lock().unwrap() = None,
        "integration_audio" => *LAST_AUDIO.lock().unwrap() = None,
        _ => {}
    }
    match id {
        "integration_quota" => poll_quota(app).await,
        "integration_space" => poll_space(app).await,
        "integration_media" => poll_media(app).await,
        "integration_messages" => poll_messages(app).await,
        "integration_shelf" => poll_shelf(app).await,
        "integration_audio" => poll_audio(app).await,
        _ => return false,
    }
    true
}

fn update(id: &'static str, data: Value, error: Option<String>, event: Option<IntegrationEvent>) -> IntegrationUpdate {
    IntegrationUpdate { id, data, error, event }
}

/// Reads one preference without holding the settings lock across an await.
fn pref<T>(app: &AppHandle, read: impl FnOnce(&crate::settings::Settings) -> T) -> Option<T> {
    app.try_state::<crate::Shared>().map(|s| read(&s.settings.lock().unwrap()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Claude usage ──────────────────────────────────────────────────────────────

/// 0 below 80 %, 1 from 80 %, 2 from 95 %: an event fires when the band rises.
static QUOTA_BAND: Mutex<Option<u8>> = Mutex::new(None);

/// Which warning band a 5-hour usage falls in.
fn quota_band(pct: f64) -> u8 {
    if pct >= 95.0 {
        2
    } else if pct >= 80.0 {
        1
    } else {
        0
    }
}

async fn poll_quota(app: AppHandle) {
    let snap = tokio::task::spawn_blocking(|| quota::read_dir(&quota::status_dir(), now_ms()))
        .await
        .unwrap_or_default();
    let five = snap.five_hour.as_ref().map(|l| l.pct);
    let band = five.map(quota_band).unwrap_or(0);
    let event = {
        let mut last = QUOTA_BAND.lock().unwrap();
        // The first reading only sets the baseline: a restart is not news.
        let rose = matches!(*last, Some(prev) if band > prev);
        *last = Some(band);
        rose.then(|| IntegrationEvent {
            success: false,
            label: format!("Claude 5h limit at {:.0}%", five.unwrap_or(0.0)),
            detail: snap.five_hour.as_ref().map(|l| format!("Resets at unix {}", l.resets_at)),
        })
    };
    let data = serde_json::to_value(&snap).unwrap_or_else(|_| json!({}));
    emit(&app, update("integration_quota", data, None, event));
}

// ── Space ─────────────────────────────────────────────────────────────────────

async fn poll_space(app: AppHandle) {
    let dir = pref(&app, |s| s.space_timebox_dir.trim().to_string())
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(space::default_dir);
    match space::fetch_today(&dir).await {
        Ok(summary) => {
            log::line(format!("space: {} items", summary.items.len()));
            let data = serde_json::to_value(&summary).unwrap_or_else(|_| json!({}));
            emit(&app, update("integration_space", data, None, None));
        }
        Err(err) => {
            log::line(format!("space failed: {err}"));
            emit(&app, update("integration_space", json!({}), Some(err), None));
        }
    }
}

// ── Music ─────────────────────────────────────────────────────────────────────

/// Last snapshot sent, so a poll every 2 s only reaches the island on change.
/// `Some(None)` = "nothing playing" was sent; `None` = nothing sent yet.
static LAST_MEDIA: Mutex<Option<Option<media::MediaInfo>>> = Mutex::new(None);

async fn poll_media(app: AppHandle) {
    let result = tokio::task::spawn_blocking(media::snapshot)
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
    // A transient WinRT failure is not worth a red card: keep the last one.
    let Ok(info) = result else { return };
    {
        let mut last = LAST_MEDIA.lock().unwrap();
        // The timeline moves on every poll; the card follows it by itself.
        let unchanged = match (last.as_ref(), info.as_ref()) {
            (Some(Some(a)), Some(b)) => media::same_media(a, b),
            (Some(None), None) => true,
            _ => false,
        };
        if unchanged {
            return;
        }
        *last = Some(info.clone());
    }
    let data = match info {
        Some(info) => serde_json::to_value(&info).unwrap_or_else(|_| json!({})),
        None => json!({}),
    };
    emit(&app, update("integration_media", data, None, None));
}

/// The cover the Music card shows, as (art_id, data URL).
pub fn media_art() -> Option<Value> {
    media::art().map(|(id, url)| json!({ "id": id, "url": url }))
}

/// Lyrics for the song on the Music card. None while the Lyrics preference
/// is off or Coucou is paused: then nothing reaches lrclib.net.
pub async fn media_lyrics(
    app: AppHandle,
    title: String,
    artist: String,
    album: String,
    duration_ms: Option<u64>,
) -> Result<Option<lyrics::Lyrics>, String> {
    if !pref(&app, |s| s.lyrics_enabled).unwrap_or(false) || crate::integrations::PAUSED.load(Ordering::Relaxed) {
        return Ok(None);
    }
    lyrics::fetch(&title, &artist, &album, duration_ms).await.map_err(|err| {
        // The error is about the network, never the song.
        log::line(format!("lyrics failed: {err}"));
        err
    })
}

/// Err when nothing may reach lrclib.net: the Lyrics preference is off or Coucou is paused.
fn lyrics_allowed(app: &AppHandle) -> Result<(), String> {
    if !pref(app, |s| s.lyrics_enabled).unwrap_or(false) {
        return Err("Lyrics are off in Settings".into());
    }
    if crate::integrations::PAUSED.load(Ordering::Relaxed) {
        return Err("Coucou is paused".into());
    }
    Ok(())
}

/// The manual lyrics search typed in the lyrics detail.
pub async fn lyrics_search(app: AppHandle, query: String, duration_ms: Option<u64>) -> Result<Vec<lyrics::Hit>, String> {
    lyrics_allowed(&app)?;
    lyrics::search(&query, duration_ms).await.map_err(|err| {
        log::line(format!("lyrics search failed: {err}"));
        err
    })
}

/// Uses the LRCLIB record picked in the search for this song (None = back to automatic).
pub async fn lyrics_choose(
    app: AppHandle,
    title: String,
    artist: String,
    album: String,
    duration_ms: Option<u64>,
    id: Option<i64>,
) -> Result<Option<lyrics::Lyrics>, String> {
    lyrics_allowed(&app)?;
    lyrics::choose(&title, &artist, &album, duration_ms, id).await.map_err(|err| {
        log::line(format!("lyrics choice failed: {err}"));
        err
    })
}

/// Play/pause, next or previous on the session the Music pill shows.
pub async fn media_control(app: AppHandle, action: String) -> Result<(), String> {
    if !["play_pause", "next", "prev"].contains(&action.as_str()) {
        return Err(format!("unknown media action: {action}"));
    }
    tokio::task::spawn_blocking(move || media::control(&action))
        .await
        .map_err(|e| e.to_string())??;
    // Show the new state now rather than at the next tick.
    *LAST_MEDIA.lock().unwrap() = None;
    poll_media(app).await;
    Ok(())
}

// ── Audio ─────────────────────────────────────────────────────────────────────

static LAST_AUDIO: Mutex<Option<audio::Snapshot>> = Mutex::new(None);

async fn poll_audio(app: AppHandle) {
    let result = tokio::task::spawn_blocking(audio::snapshot).await.unwrap_or_else(|e| Err(e.to_string()));
    // A device unplugged mid-read is not worth a red card: keep the last one.
    let Ok(snap) = result else { return };
    {
        let mut last = LAST_AUDIO.lock().unwrap();
        if last.as_ref() == Some(&snap) {
            return;
        }
        *last = Some(snap.clone());
    }
    let data = serde_json::to_value(&snap).unwrap_or_else(|_| json!({}));
    emit(&app, update("integration_audio", data, None, None));
}

/// Runs a blocking audio change, then shows the new state at once.
async fn audio_then_refresh(app: AppHandle, work: impl FnOnce() -> Result<(), String> + Send + 'static) -> Result<(), String> {
    tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())??;
    *LAST_AUDIO.lock().unwrap() = None;
    poll_audio(app).await;
    Ok(())
}

pub async fn audio_set_default(app: AppHandle, id: String) -> Result<(), String> {
    audio_then_refresh(app, move || audio::set_default(&id)).await
}

pub async fn audio_set_volume(app: AppHandle, flow: String, volume: f64) -> Result<(), String> {
    let flow = audio::parse_flow(&flow)?;
    let volume = audio::clamp_volume(volume);
    audio_then_refresh(app, move || audio::set_volume(flow, volume)).await
}

pub async fn audio_set_mute(app: AppHandle, flow: String, muted: bool) -> Result<(), String> {
    let flow = audio::parse_flow(&flow)?;
    audio_then_refresh(app, move || audio::set_mute(flow, muted)).await
}

// ── Shelf ─────────────────────────────────────────────────────────────────────

static LAST_SHELF: Mutex<Option<shelf::Snapshot>> = Mutex::new(None);

async fn poll_shelf(app: AppHandle) {
    let Ok(snap) = tokio::task::spawn_blocking(shelf::snapshot).await else { return };
    {
        let mut last = LAST_SHELF.lock().unwrap();
        if last.as_ref() == Some(&snap) {
            return;
        }
        *last = Some(snap.clone());
    }
    let data = serde_json::to_value(&snap).unwrap_or_else(|_| json!({}));
    emit(&app, update("integration_shelf", data, None, None));
}

/// Runs a blocking shelf call, then shows the result on the card at once.
async fn shelf_then_refresh<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let out = tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())??;
    *LAST_SHELF.lock().unwrap() = None;
    poll_shelf(app).await;
    Ok(out)
}

pub async fn shelf_pin(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    shelf_then_refresh(app, move || shelf::pin_paths(&paths)).await
}

pub async fn shelf_unpin(app: AppHandle, path: String) -> Result<(), String> {
    shelf_then_refresh(app, move || shelf::unpin_path(&path)).await
}

pub async fn shelf_clear(app: AppHandle) -> Result<(), String> {
    shelf_then_refresh(app, shelf::clear_pins).await
}

pub async fn shelf_thumb(path: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || shelf::thumbnail(&path)).await.map_err(|e| e.to_string())?
}

pub async fn shelf_open(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || shelf::open(&path)).await.map_err(|e| e.to_string())?
}

pub async fn shelf_reveal(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || shelf::reveal(&path)).await.map_err(|e| e.to_string())?
}

pub async fn shelf_copy(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || shelf::copy(&path)).await.map_err(|e| e.to_string())?
}

/// Drags shelf files out of the island as real files (OLE DoDragDrop).
/// Resolves when the drag ends: true when they were dropped somewhere.
///
/// DoDragDrop runs its own modal message loop until the drop. Run inside a
/// `run_on_main_thread` closure, that loop would pump messages from within
/// tao's event handler and re-enter it, which crashed the app on the first
/// drag. So the closure only arms a zero-delay Win32 timer; tao's message
/// loop dispatches the timer like any other message, outside its handler,
/// the way menus and window resizing run their own modal loops.
#[cfg(windows)]
pub async fn shelf_drag(app: AppHandle, paths: Vec<String>) -> Result<bool, String> {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    static DRAGGING: AtomicBool = AtomicBool::new(false);

    shelf::check_all(&paths)?;
    let first = paths.first().cloned().ok_or("Nothing to drag")?;
    if DRAGGING.swap(true, Ordering::SeqCst) {
        return Err("A drag is already under way".into());
    }
    let preview = tokio::task::spawn_blocking(move || shelf::drag_preview(&first)).await.ok().flatten();
    let Some(win) = crate::island::window(&app) else {
        DRAGGING.store(false, Ordering::SeqCst);
        return Err("The island is not open".into());
    };
    let Some(hwnd) = crate::platform::hwnd_of(&win) else {
        DRAGGING.store(false, Ordering::SeqCst);
        return Err("The island has no window".into());
    };
    let hwnd = hwnd.0 as isize;
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let done = tx.clone();
    let count = paths.len();
    let job: drag_out::Job = Box::new(move || {
        log::line(format!("shelf drag: start ({count} file(s))"));
        let files = paths.iter().map(std::path::PathBuf::from).collect();
        // An empty image leaves Windows' own drag image.
        let image = drag::Image::Raw(preview.unwrap_or_default());
        let sent = done.clone();
        let started = drag::start_drag(
            &win,
            drag::DragItem::Files(files),
            image,
            move |result, _| {
                let dropped = matches!(result, drag::DragResult::Dropped);
                log::line(format!("shelf drag: {}", if dropped { "dropped" } else { "cancelled" }));
                if let Some(tx) = sent.lock().unwrap().take() {
                    let _ = tx.send(dropped);
                }
            },
            drag::Options::default(),
        );
        if let Err(e) = started {
            log::line(format!("shelf drag failed: {e}"));
        }
        // Whatever happened, the command resolves.
        if let Some(tx) = done.lock().unwrap().take() {
            let _ = tx.send(false);
        }
    });
    let armed = app.run_on_main_thread(move || drag_out::run_outside_handler(hwnd, job));
    drop(tx);
    let dropped = match armed {
        Ok(()) => rx.await.unwrap_or(false),
        Err(e) => {
            DRAGGING.store(false, Ordering::SeqCst);
            return Err(e.to_string());
        }
    };
    DRAGGING.store(false, Ordering::SeqCst);
    Ok(dropped)
}

/// Runs a job on the main thread from a Win32 timer, outside tao's event handler.
#[cfg(windows)]
mod drag_out {
    use std::sync::Mutex;

    use ::windows::Win32::Foundation::HWND;
    use ::windows::Win32::UI::WindowsAndMessaging::{KillTimer, SetTimer};

    pub type Job = Box<dyn FnOnce() + Send>;

    static PENDING: Mutex<Option<Job>> = Mutex::new(None);

    unsafe extern "system" fn fire(hwnd: HWND, _: u32, id: usize, _: u32) {
        let _ = unsafe { KillTimer(Some(hwnd), id) };
        let job = PENDING.lock().unwrap().take();
        if let Some(job) = job {
            // A panic must never unwind into Windows.
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).is_err() {
                crate::log::line("shelf drag: panicked");
            }
        }
    }

    /// Id of the one drag timer on the island window.
    const TIMER_ID: usize = 0xC0C0;

    /// Must be called on the main thread, which owns `hwnd`. The timer is the
    /// island window's, with our TIMERPROC: DispatchMessage calls it directly
    /// (a timer with no window is a thread message, which tao never dispatches).
    pub fn run_outside_handler(hwnd: isize, job: Job) {
        *PENDING.lock().unwrap() = Some(job);
        let hwnd = HWND(hwnd as *mut _);
        let id = unsafe { SetTimer(Some(hwnd), TIMER_ID, 0, Some(fire)) };
        if id == 0 {
            crate::log::line("shelf drag: timer failed");
        }
    }
}

#[cfg(not(windows))]
pub async fn shelf_drag(_app: AppHandle, _paths: Vec<String>) -> Result<bool, String> {
    Err("Dragging out is Windows only for now".into())
}

// ── Messages ──────────────────────────────────────────────────────────────────

struct Inbox {
    listener: notify::Listener,
    asked: bool,
    history: VecDeque<notify::Message>,
}

static INBOX: std::sync::LazyLock<Mutex<Inbox>> = std::sync::LazyLock::new(|| {
    Mutex::new(Inbox { listener: notify::Listener::new(), asked: false, history: VecDeque::new() })
});

/// The label of the event a batch of new messages raises.
fn messages_event(new: &[notify::Message]) -> Option<IntegrationEvent> {
    let first = new.first()?;
    if new.len() > 1 {
        return Some(IntegrationEvent {
            success: true,
            label: format!("{} new messages", new.len()),
            detail: Some(format!("{} · {}", first.sender, first.text)),
        });
    }
    let place = [first.place.as_deref(), first.channel.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" › ");
    let label = if place.is_empty() { first.sender.clone() } else { format!("{} · {}", first.sender, place) };
    Some(IntegrationEvent { success: true, label, detail: Some(first.text.clone()) })
}

/// Takes messages off the card: the ones the user opened, or all of them
/// (`ids` = None). Returns whether anything went.
fn drop_messages(history: &mut VecDeque<notify::Message>, ids: Option<&[u32]>) -> bool {
    let before = history.len();
    match ids {
        None => history.clear(),
        Some(ids) => history.retain(|m| !ids.contains(&m.id)),
    }
    history.len() != before
}

/// The Messages card's row click (opened) and Clear all. The listener already
/// remembers these toasts as seen, so a cleared message never comes back.
pub fn dismiss_messages(app: &AppHandle, ids: Option<Vec<u32>>) {
    let history: Vec<notify::Message> = {
        let mut inbox = INBOX.lock().unwrap();
        if !drop_messages(&mut inbox.history, ids.as_deref()) {
            return;
        }
        inbox.history.iter().cloned().collect()
    };
    log::line(format!("messages: cleared, {} left", history.len()));
    emit(app, update("integration_messages", json!({ "messages": history }), None, None));
}

async fn poll_messages(app: AppHandle) {
    let apps = pref(&app, |s| s.message_apps.clone()).unwrap_or_default();
    let workspace = pref(&app, |s| s.slack_workspace.clone()).unwrap_or_default();
    let result = tokio::task::spawn_blocking(move || {
        let mut inbox = INBOX.lock().unwrap();
        if !inbox.asked {
            inbox.asked = true;
            match notify::request_access() {
                Ok(true) => {}
                Ok(false) => return Err("Notification access is off: Settings → Privacy → Notifications.".to_string()),
                Err(e) => return Err(e),
            }
        }
        let polled = inbox.listener.poll(&apps, &workspace)?;
        for m in polled.messages.iter().rev() {
            inbox.history.push_front(m.clone());
        }
        inbox.history.truncate(MESSAGE_HISTORY);
        let history: Vec<notify::Message> = inbox.history.iter().cloned().collect();
        Ok((polled, history))
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));

    match result {
        Ok((polled, history)) => {
            // The first poll fills the card with what is already in Action
            // Center; only later ones are news.
            let event = if polled.first { None } else { messages_event(&polled.messages) };
            if !polled.messages.is_empty() {
                let mut per_app: Vec<&str> = polled.messages.iter().map(|m| m.app.as_str()).collect();
                per_app.dedup();
                log::line(format!("messages: +{} ({})", polled.messages.len(), per_app.join(",")));
            } else if !polled.first {
                return; // nothing new: the island already has this list
            }
            emit(&app, update("integration_messages", json!({ "messages": history }), None, event));
        }
        Err(err) => {
            log::line(format!("messages failed: {err}"));
            // Ask again next time: access may have been granted meanwhile.
            INBOX.lock().unwrap().asked = false;
            emit(&app, update("integration_messages", json!({}), Some(err), None));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(sender: &str, place: Option<&str>, channel: Option<&str>, text: &str) -> notify::Message {
        msg_id(1, sender, place, channel, text)
    }

    fn msg_id(id: u32, sender: &str, place: Option<&str>, channel: Option<&str>, text: &str) -> notify::Message {
        notify::Message {
            id,
            app: "slack".into(),
            sender: sender.into(),
            place: place.map(Into::into),
            channel: channel.map(Into::into),
            text: text.into(),
            at: 0,
        }
    }

    #[test]
    fn quota_bands_rise_at_80_and_95() {
        assert_eq!(quota_band(10.0), 0);
        assert_eq!(quota_band(79.9), 0);
        assert_eq!(quota_band(80.0), 1);
        assert_eq!(quota_band(94.9), 1);
        assert_eq!(quota_band(95.0), 2);
        assert_eq!(quota_band(100.0), 2);
    }

    #[test]
    fn one_message_names_sender_and_place() {
        let e = messages_event(&[msg("Budi", Some("Venturo"), Some("#dev"), "build naik")]).unwrap();
        assert_eq!(e.label, "Budi · Venturo › #dev");
        assert_eq!(e.detail.as_deref(), Some("build naik"));
        let dm = messages_event(&[msg("Ibu", None, None, "makan")]).unwrap();
        assert_eq!(dm.label, "Ibu");
    }

    #[test]
    fn a_burst_is_one_event() {
        let e = messages_event(&[msg("A", None, None, "1"), msg("B", None, None, "2")]).unwrap();
        assert_eq!(e.label, "2 new messages");
        assert_eq!(e.detail.as_deref(), Some("A · 1"));
        assert!(messages_event(&[]).is_none());
    }

    #[test]
    fn opened_messages_leave_the_card_and_clear_all_empties_it() {
        let mut h: VecDeque<_> = (1..=4).map(|i| msg_id(i, "A", None, None, "x")).collect();
        assert!(drop_messages(&mut h, Some(&[2, 4])));
        assert_eq!(h.iter().map(|m| m.id).collect::<Vec<_>>(), vec![1, 3]);
        assert!(!drop_messages(&mut h, Some(&[9])), "an unknown id changes nothing");
        assert!(drop_messages(&mut h, None));
        assert!(h.is_empty());
        assert!(!drop_messages(&mut h, None), "clearing an empty card is a no-op");
    }
}
