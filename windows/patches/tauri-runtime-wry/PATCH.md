# Coucou patch to tauri-runtime-wry 2.12.0

This folder is the published `tauri-runtime-wry` 2.12.0 crate (MIT / Apache-2.0,
licences alongside) with one change, applied through `[patch.crates-io]` in
`windows/Cargo.toml`. Every change is marked `COUCOU PATCH` in `src/lib.rs`.

## The bug

`DispatcherMainThreadContext::window_target` held tao's `EventLoopWindowTarget`,
which on Windows owns an `Rc<EventLoopRunner>`. The struct derives `Clone`, and it
sits inside `Context`, which every `AppHandle` and `Webview` carries and clones.
Tauri clones those from any thread: our pollers, async commands, the 60 Hz
cursor thread (`island.rs`), WebView2's custom protocol thread. Each clone or
drop off the main thread touched the `Rc`'s non-atomic refcount while the main
thread used it too.

What it looked like: the debug build aborting with
`unsafe precondition(s) violated: hint::assert_unchecked must never be called`
in `Rc::inc_strong` (`rc.rs:3743`), backtrace through `island::window` →
`get_webview_window` → `Webview::clone` → `Context::clone`. The release build has
no such check, so there it was silent memory corruption and random crashes.
It is upstream issue tauri-apps/tauri#15408 (May 2026), still present in 2.12.1.

## The change

`window_target: Arc<EventLoopWindowTarget<Message<T>>>`, built once with
`Arc::new(event_loop.deref().clone())` on the main thread. Cloning `Context`
anywhere now bumps an atomic `Arc` count; the inner `Rc` is only ever cloned on
the main thread. Every other use reads it through `Deref`, unchanged.

## Proof

`windows/scripts/rc-stress.ps1` runs the debug build with
`COUCOU_STRESS_CLONES=<n>` (`src-tauri/src/rc_guard.rs`): 4 threads clone and drop
the `AppHandle` while the app runs.

| Build | 1 000 clones per thread | 200 000 clones per thread |
|---|---|---|
| stock 2.12.0 | crashed, `rc.rs:3743` precondition | crashed (abort or WebView2 creation failing on the corrupted runner) |
| patched | survived | survived, still alive 5 s later (3 runs out of 3) |

A run with 0 clones starts normally on the same profile, so the failures come
from the clones.

## Keeping it honest

- `src-tauri/Cargo.toml` pins `tauri = "=2.12.0"`: this patch is for that
  version.
- `src-tauri/src/rc_guard.rs` holds a function that only compiles when
  `window_target` is an `Arc`. If a Tauri upgrade leaves the patch unused,
  the build fails there (checked: removing `[patch]` gives E0308 at
  `rc_guard.rs:14`).

## Upgrading Tauri / dropping the patch

1. If upstream has fixed #15408 in the new version: delete this folder and the
   `[patch.crates-io]` entry, delete `patched_window_target_is_arc` in
   `rc_guard.rs`, and unpin `tauri`. Run `scripts/rc-stress.ps1` on the result.
2. If not: copy the new `tauri-runtime-wry` from `~/.cargo/registry/src/*/`
   here, re-apply the two `COUCOU PATCH` lines, bump both pins, and run the
   stress script.
