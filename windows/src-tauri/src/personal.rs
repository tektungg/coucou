// Pollers for this build's own pills: Claude usage, Space, music, messages.
//
// Same pipe as the stock integrations (integrations.rs): each emits an
// `integration` event and the island owns badges, sounds and cards. None of
// them needs a key or reaches a service the user did not already use: the
// status files are local, Space goes through the user's own MCP server, and
// music and messages come from Windows itself.
//
// Message text and song titles are never logged.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::integrations::{emit, spawn, IntegrationEvent, IntegrationUpdate};
use crate::{log, media, notify, quota, space};

/// Messages kept for the card. In memory only: they die with the app.
const MESSAGE_HISTORY: usize = 15;

pub fn start(app: AppHandle) {
    spawn(app.clone(), "integration_quota", 2, 5, poll_quota);
    spawn(app.clone(), "integration_media", 2, 2, poll_media);
    spawn(app.clone(), "integration_messages", 3, 3, poll_messages);
    // Starting uv + Python costs ~3 s: five minutes is plenty for a day plan.
    spawn(app, "integration_space", 4, 300, poll_space);
}

/// One-shot refresh; false when `id` is not a personal pill.
pub async fn poll_once(app: AppHandle, id: &str) -> bool {
    match id {
        "integration_quota" => poll_quota(app).await,
        "integration_space" => poll_space(app).await,
        "integration_media" => poll_media(app).await,
        "integration_messages" => poll_messages(app).await,
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
static LAST_MEDIA: Mutex<Option<Value>> = Mutex::new(None);

async fn poll_media(app: AppHandle) {
    let result = tokio::task::spawn_blocking(media::snapshot)
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
    let data = match result {
        Ok(Some(info)) => serde_json::to_value(&info).unwrap_or_else(|_| json!({})),
        Ok(None) => json!({}),
        // A transient WinRT failure is not worth a red card: keep the last one.
        Err(_) => return,
    };
    {
        let mut last = LAST_MEDIA.lock().unwrap();
        if last.as_ref() == Some(&data) {
            return;
        }
        *last = Some(data.clone());
    }
    emit(&app, update("integration_media", data, None, None));
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
        notify::Message {
            id: 1,
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
}
