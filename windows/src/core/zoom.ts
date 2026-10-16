// Keeps one CSS pixel equal to one logical window pixel. WebView2's
// devicePixelRatio folds in the Windows text size and can differ from the
// window's scale, which leaves the island cut on both sides; Rust corrects the
// webview zoom (lib.rs fit_zoom). Ported from upstream (Louis-CFM/coucou
// b9b9217); the ratio watch re-arms itself, so every change is seen.

import { Bridge } from "./bridge";

/** How often, and how many times, to look for the new ratio after a zoom change. */
const SETTLE_STEP_MS = 25;
const SETTLE_STEPS = 20;

const ratio = () => window.devicePixelRatio || 1;

/**
 * Asks Rust to correct the zoom and, when it did, waits (up to half a second)
 * for the page to report the new ratio, so nothing is sized against the old one.
 */
export async function fitZoom(): Promise<void> {
  const before = ratio();
  if (!(await Bridge.fitZoom(before))) return;
  for (let i = 0; i < SETTLE_STEPS && ratio() === before; i++) {
    await new Promise((resolve) => window.setTimeout(resolve, SETTLE_STEP_MS));
  }
}

/** Calls `onChange` each time the pixel ratio changes (a text size or display change). */
export function watchPixelRatio(onChange: () => void) {
  const query = window.matchMedia(`(resolution: ${ratio()}dppx)`);
  query.addEventListener("change", () => {
    onChange();
    watchPixelRatio(onChange);
  }, { once: true });
}

/** Ctrl + wheel and Ctrl + / - / 0 would zoom the page out of its layout. */
export function blockPageZoom() {
  window.addEventListener("wheel", (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && ["+", "-", "=", "0"].includes(e.key)) e.preventDefault();
  });
}
