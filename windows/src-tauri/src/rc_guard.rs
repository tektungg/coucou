//! Guards for the vendored tauri-runtime-wry patch (windows/patches/tauri-runtime-wry/PATCH.md).
//!
//! Tauri clones `AppHandle` / `Webview` from any thread, and every clone used to
//! clone tao's `Rc<EventLoopRunner>` too: a non-atomic refcount touched off the
//! main thread (tauri-apps/tauri#15408). The patch puts it behind an `Arc`.

/// Compile-time proof that the patched tauri-runtime-wry is the one in use: the
/// window target must sit behind an `Arc`. With the stock crate (a Tauri upgrade
/// that left the patch behind, say) this stops compiling. Never called.
#[allow(dead_code)]
fn patched_window_target_is_arc(
    ctx: &tauri_runtime_wry::DispatcherMainThreadContext<tauri::EventLoopMessage>,
) {
    let _: &std::sync::Arc<_> = &ctx.window_target;
}

/// Debug builds only: `COUCOU_STRESS_CLONES=<n>` clones and drops the `AppHandle`
/// `n` times on each of 4 threads while the app runs, the way the pollers and
/// the cursor thread do, only much faster. Unpatched, this aborts within seconds
/// with "unsafe precondition(s) violated" in `Rc::inc_strong`; patched, it
/// finishes and logs how long it took.
#[cfg(debug_assertions)]
pub fn maybe_stress(app: &tauri::AppHandle) {
    let Some(n) = std::env::var("COUCOU_STRESS_CLONES").ok().and_then(|v| v.parse::<u64>().ok()) else {
        return;
    };
    crate::log::line(format!("rc stress: 4 threads x {n} AppHandle clones"));
    eprintln!("[coucou] rc stress: 4 threads x {n} AppHandle clones");
    let start = std::time::Instant::now();
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let app = app.clone(); // on the main thread (setup)
            std::thread::spawn(move || {
                for _ in 0..n {
                    let clone = app.clone();
                    drop(clone);
                }
            })
        })
        .collect();
    std::thread::spawn(move || {
        for w in workers {
            let _ = w.join();
        }
        let msg = format!("rc stress: done in {:?}, no corruption caught", start.elapsed());
        crate::log::line(&msg);
        eprintln!("[coucou] {msg}");
    });
}
