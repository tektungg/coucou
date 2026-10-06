// Files dropped on the island, through WebView2 itself.
//
// A drop from another app (File Explorer) never reached an OLE target in our
// own process on Windows 11: not wry's, not one of ours, although Windows
// found it under the cursor (drags started inside Coucou did reach it). So
// WebView2 takes the drop, like Edge does: external drops are allowed, the
// page gets ordinary HTML5 drag events, and on drop it hands the File objects
// to us with `chrome.webview.postMessageWithAdditionalObjects`. Each one is an
// ICoreWebView2File, which carries the real path. The paths go to the island
// as the `island-drop` event (core/bridge.ts onDragDrop).
//
// File names never reach the log, only counts.

use serde::Serialize;
use tauri::{AppHandle, Emitter, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller4, ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
};
use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
use windows_core_wv2::{Interface, PWSTR};

use crate::island::WINDOW_LABEL;
use crate::log;

/// What the page posts on drop (src/core/bridge.ts).
pub const DROP_MESSAGE: &str = "coucou-drop";

#[derive(Serialize, Clone)]
struct DropEvent {
    #[serde(rename = "type")]
    kind: &'static str,
    paths: Vec<String>,
}

/// The paths of the files a `coucou-drop` message carries.
fn dropped_paths(args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs) -> Vec<String> {
    let mut out = Vec::new();
    unsafe {
        let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else { return out };
        let Ok(objects) = args2.AdditionalObjects() else { return out };
        let mut count = 0u32;
        if objects.Count(&mut count).is_err() {
            return out;
        }
        for i in 0..count {
            let Ok(object) = objects.GetValueAtIndex(i) else { continue };
            let Ok(file) = object.cast::<ICoreWebView2File>() else { continue };
            let mut path = PWSTR::null();
            if file.Path(&mut path).is_ok() {
                let path = take_pwstr(path);
                if !path.is_empty() {
                    out.push(path);
                }
            }
        }
    }
    out
}

/// Lets WebView2 accept dropped files and passes their paths on. Once, at start.
pub fn install(app: &AppHandle, win: &WebviewWindow) {
    let app = app.clone();
    let result = win.with_webview(move |webview| unsafe {
        let controller = webview.controller();
        // wry turned external drops off to use its own target; WebView2's is
        // the one Explorer's drags actually reach.
        let allowed = controller
            .cast::<ICoreWebView2Controller4>()
            .and_then(|c| c.SetAllowExternalDrop(true))
            .is_ok();
        let Ok(core) = controller.CoreWebView2() else {
            log::line("drop: no WebView2 core");
            return;
        };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut message = PWSTR::null();
            // Tauri's own messages are JSON objects, not strings: they fail here.
            if args.TryGetWebMessageAsString(&mut message).is_err() {
                return Ok(());
            }
            if take_pwstr(message) != DROP_MESSAGE {
                return Ok(());
            }
            let paths = dropped_paths(&args);
            log::line(format!("drop: {} file(s)", paths.len()));
            let _ = app.emit_to(WINDOW_LABEL, "island-drop", DropEvent { kind: "drop", paths });
            Ok(())
        }));
        let mut token = 0i64;
        let listening = core.add_WebMessageReceived(&handler, &mut token).is_ok();
        log::line(format!("drop: webview drops allowed={allowed} listening={listening}"));
    });
    if let Err(e) = result {
        log::line(format!("drop: webview unavailable: {e}"));
    }
}
