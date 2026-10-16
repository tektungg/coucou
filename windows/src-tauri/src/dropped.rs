// Paths a real drop delivered.
//
// `ingest_file` and `shelf_pin` are callable from the page, so on their own
// they would copy or pin any file the user can read: a script injected into
// the page could pull ~/.ssh onto the shelf and then onto the clipboard. Only
// paths the OS just delivered through a real drop are accepted: WebView2's
// drop objects (webdrop.rs) and Tauri's drag-drop window event (lib.rs).
//
// A path stays good for a while and is not used up: the choose card can sit
// open before "Keep on shelf" or "Ask Claude" is clicked, and both act on the
// same drop. The list is bounded so a flood of drops cannot grow it.

use std::time::{Duration, Instant};

use crate::shelf::same_path;

/// How long a dropped path may be ingested or pinned.
const VALID_FOR: Duration = Duration::from_secs(10 * 60);
/// Paths remembered at once; the oldest go first.
const MAX_PENDING: usize = 64;

type Pending = Vec<(String, Instant)>;

/// Runs `f` on the list. Process-wide in the app; one list per thread under
/// `cargo test`, so tests running in parallel never see each other's drops.
fn with_list<R>(f: impl FnOnce(&mut Pending) -> R) -> R {
    #[cfg(not(test))]
    {
        use std::sync::{Mutex, PoisonError};
        static DROPPED: Mutex<Pending> = Mutex::new(Vec::new());
        f(&mut DROPPED.lock().unwrap_or_else(PoisonError::into_inner))
    }
    #[cfg(test)]
    {
        thread_local!(static DROPPED: std::cell::RefCell<Pending> = const { std::cell::RefCell::new(Vec::new()) });
        DROPPED.with(|list| f(&mut list.borrow_mut()))
    }
}

/// Records paths that came from a real drop.
pub fn allow<I: IntoIterator<Item = String>>(paths: I) {
    allow_at(paths, Instant::now());
}

/// True when `path` was delivered by a drop in the last few minutes.
pub fn is_allowed(path: &str) -> bool {
    is_allowed_at(path, Instant::now())
}

fn allow_at<I: IntoIterator<Item = String>>(paths: I, now: Instant) {
    with_list(|list| {
        forget_expired(list, now);
        for path in paths {
            list.retain(|(p, _)| !same_path(p, &path));
            list.push((path, now));
        }
        let excess = list.len().saturating_sub(MAX_PENDING);
        list.drain(..excess);
    });
}

fn is_allowed_at(path: &str, now: Instant) -> bool {
    with_list(|list| {
        forget_expired(list, now);
        list.iter().any(|(p, _)| same_path(p, path))
    })
}

fn forget_expired(list: &mut Pending, now: Instant) {
    list.retain(|(_, at)| now.saturating_duration_since(*at) < VALID_FOR);
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "/tmp/coucou-dropped-test/note.txt";

    #[test]
    fn a_path_never_dropped_is_refused() {
        assert!(!is_allowed(P));
    }

    #[test]
    fn a_dropped_path_is_allowed_more_than_once_until_it_expires() {
        let now = Instant::now();
        allow_at([P.to_string()], now);
        assert!(is_allowed_at(P, now));
        assert!(is_allowed_at(P, now + Duration::from_secs(1)), "not used up by a check");
        assert!(!is_allowed_at(P, now + VALID_FOR), "expired");
    }

    #[test]
    fn dropping_a_file_again_restarts_its_clock_without_a_duplicate() {
        let now = Instant::now();
        allow_at([P.to_string()], now);
        allow_at([P.to_string()], now + Duration::from_secs(60));
        assert!(is_allowed_at(P, now + VALID_FOR));
        assert_eq!(with_list(|list| list.len()), 1);
    }

    #[test]
    fn the_list_stays_bounded_and_drops_the_oldest() {
        let now = Instant::now();
        allow_at((0..200).map(|i| format!("/tmp/coucou-dropped-test/bounded-{i}")), now);
        assert_eq!(with_list(|list| list.len()), MAX_PENDING);
        assert!(is_allowed_at("/tmp/coucou-dropped-test/bounded-199", now));
        assert!(!is_allowed_at("/tmp/coucou-dropped-test/bounded-0", now));
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_match_whatever_their_case() {
        allow([r"C:\Users\Me\Desktop\Shot.PNG".to_string()]);
        assert!(is_allowed(r"c:\users\me\desktop\shot.png"));
    }
}
