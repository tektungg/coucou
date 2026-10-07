// Dev harness: Mochi's music groove (headphones + dance) in a plain browser, so
// it can be watched without Spotify playing. Not part of the app bundle.
// Open http://127.0.0.1:1420/dev/dance-preview.html with `npm run dev`.
// `?paused` starts with the music off; `?t=<seconds>` freezes the clock there.

import { BotEngine, hexToRGB } from "../src/mochi/engine";
import { isDancing, MEDIA_PILL_ID } from "../src/mochi/dance";
import type { BotStateName } from "../src/core/layout";

const MUSIC_GREEN = "#1DB954"; // core/state.ts, integration_media
const params = new URLSearchParams(location.search);
const frozen = params.has("t") ? Number(params.get("t")) : null;
let state: BotStateName = params.has("paused") ? "idle" : "working";

const stage = document.getElementById("stage")!;
const toggle = document.getElementById("toggle") as HTMLButtonElement;
const info = document.getElementById("info")!;
const dpr = Math.min(2, window.devicePixelRatio || 1);

/** Same sizing as the island (BOT_OVERHANG 40) and the pills (body / 0.6). */
function makeBot(size: number, overhang: number, mini: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round((size + overhang) * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size + overhang}px`;
  stage.append(canvas);
  const engine = new BotEngine();
  engine.isMini = mini;
  engine.bodyColor = hexToRGB(MUSIC_GREEN);
  engine.particleOverhang = overhang;
  return { canvas, engine, size, overhang };
}

const bots = [makeBot(150, 40, false), makeBot(72, 40, false), makeBot(22 / 0.6, 0, true)];

function apply() {
  const task = { id: MEDIA_PILL_ID, state };
  for (const b of bots) {
    b.engine.setState(state);
    b.engine.dancing = isDancing(task);
    if (frozen != null) b.engine.groove = b.engine.dancing ? 1 : 0;
  }
  toggle.textContent = state === "working" ? "Pause" : "Play";
  info.textContent = `Music pill: ${state} → dancing ${isDancing(task)}`;
}
toggle.onclick = () => { state = state === "working" ? "idle" : "working"; apply(); };
apply();

// Freezing the clock: performance.now() drives the engine, so pin it.
if (frozen != null) {
  const base = performance.now();
  performance.now = () => base + frozen * 1000;
}

let last = performance.now();
function loop() {
  const n = performance.now();
  const dt = frozen != null ? 1 / 60 : Math.min(0.05, (n - last) / 1000);
  last = n;
  for (const b of bots) {
    const ctx = b.canvas.getContext("2d")!;
    b.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, b.size, b.size + b.overhang);
    b.engine.draw(ctx, b.size, b.size + b.overhang);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
