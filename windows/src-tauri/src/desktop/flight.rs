// Flights (to and from the island, the snap after a drop) and the drop itself.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use super::coords::{displays, island_anchor, side};
use super::logic;
use super::state::Source;
use super::window::{hide, place, refresh};
use super::{prefs, Desktop, EVENT_DROPPED, MARGIN, SIZE, SNAP_MS, TICK_MS};
use crate::island;

/// What the island page hears when a drop is over.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Dropped {
    from: Source,
    home: bool,
}

/// Moves him from where he is to `to`, then lands him. False when another
/// flight took over before the end.
pub(super) async fn fly(app: &AppHandle, d: &Desktop, to: (f64, f64), ms: u64, ease: fn(f64) -> f64) -> bool {
    let token = d.flight.fetch_add(1, Ordering::SeqCst) + 1;
    let from = d.inner.lock().unwrap().pos;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app = app.clone();
    std::thread::spawn(move || {
        let d = app.state::<Arc<Desktop>>();
        let steps = (ms / TICK_MS).max(1);
        for k in 1..=steps {
            if d.flight.load(Ordering::SeqCst) != token {
                let _ = tx.send(false);
                return;
            }
            let t = k as f64 / steps as f64;
            place(&app, &d, logic::lerp(from, to, ease(t)));
            std::thread::sleep(Duration::from_millis(TICK_MS));
        }
        let _ = tx.send(d.flight.load(Ordering::SeqCst) == token);
    });
    rx.await.unwrap_or(false)
}

/// The drop, wherever it came from: home if it is over the island's panel,
/// otherwise his new spot.
pub(super) async fn finish_drop(app: &AppHandle, d: &Desktop, pos: (f64, f64), from: Source) {
    let home = over_home(app, d, pos);
    {
        let mut i = d.inner.lock().unwrap();
        i.carry = None;
        i.landed = !home;
    }
    if !home {
        settle_into_spot(app, d, pos).await;
    } else if from == Source::Island {
        // Back where he came from: he simply reappears in the island.
        hide(app, d);
    } else {
        // The island page flies him home (and forgets the spot).
        refresh(app, d);
    }
    let _ = app.emit_to(island::WINDOW_LABEL, EVENT_DROPPED, Dropped { from, home });
}

/// His centre, with the window's top-left at `pos`, is over the island's panel.
fn over_home(app: &AppHandle, d: &Desktop, pos: (f64, f64)) -> bool {
    let s = side(app, d);
    let center = (pos.0 + s / 2.0, pos.1 + s / 2.0);
    island_anchor(app, d)
        .map(|(cx, top, scale)| logic::home_zone(cx, top, scale).contains(center))
        .unwrap_or(false)
}

/// Pulls a drop back inside the work area, with the landing squash, and
/// remembers where he ended up.
async fn settle_into_spot(app: &AppHandle, d: &Desktop, pos: (f64, f64)) {
    let spot = logic::settle(pos, &displays(app, d), SIZE, MARGIN);
    refresh(app, d);
    if spot != pos {
        fly(app, d, spot, SNAP_MS, logic::ease_out_back).await;
    }
    prefs::remember_spot(app, d, spot, true);
}
