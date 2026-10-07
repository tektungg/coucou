// Dev harness: every Mochi act (mochi/acts.ts) side by side in a plain browser,
// so they can be watched without music, a call, a message or a new file.
// Not part of the app bundle. With `npm run dev`, open
// http://127.0.0.1:1420/dev/acts-preview.html
// One-shots replay on a loop. `?t=<seconds>` freezes every act at that age.

import { BotEngine, hexToRGB } from "../src/mochi/engine";
import { actDurationMs, type Act, type ActName } from "../src/mochi/acts";

const params = new URLSearchParams(location.search);
const frozen = params.has("t") ? Number(params.get("t")) : null;
const base = performance.now();
// A plain assignment does not stick in every browser; define it to pin the clock.
if (frozen != null) Object.defineProperty(performance, "now", { value: () => base, configurable: true });

// Pill colours from core/state.ts.
const CASES: { label: string; name: ActName; variant: string | null; color: string }[] = [
  { label: "Music · dance", name: "dance", variant: null, color: "#1DB954" },
  { label: "Audio · mic", name: "mic", variant: null, color: "#A78BFA" },
  { label: "Audio · muted", name: "mic", variant: "muted", color: "#A78BFA" },
  { label: "Messages · mail", name: "mail", variant: null, color: "#5865F2" },
  { label: "Shelf · catch", name: "catch", variant: null, color: "#F5A524" },
  { label: "Space · check", name: "check", variant: null, color: "#4F8EF7" },
  { label: "Space · all done", name: "check", variant: "all", color: "#4F8EF7" },
  { label: "idle", name: "dance", variant: "none", color: "#4F8EF7" },
];

const stage = document.getElementById("stage")!;
const dpr = Math.min(2, window.devicePixelRatio || 1);
const SIZE = 150;
const OVERHANG = 40; // island.ts BOT_OVERHANG

const bots = CASES.map((c) => {
  const cell = document.createElement("div");
  cell.className = "cell";
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(SIZE * dpr);
  canvas.height = Math.round((SIZE + OVERHANG) * dpr);
  canvas.style.width = `${SIZE}px`;
  canvas.style.height = `${SIZE + OVERHANG}px`;
  const label = document.createElement("span");
  label.textContent = c.label;
  cell.append(canvas, label);
  stage.append(cell);
  const engine = new BotEngine();
  engine.bodyColor = hexToRGB(c.color);
  engine.particleOverhang = OVERHANG;
  return { c, canvas, engine };
});

/** The act each case plays now: one-shots restart every (duration + 1 s). */
function actNow(c: (typeof CASES)[number], nowMs: number): Act | null {
  if (c.variant === "none") return null;
  const d = actDurationMs(c.name, c.variant);
  if (!Number.isFinite(d)) return { name: c.name, variant: c.variant, at: 0 };
  if (frozen != null) return { name: c.name, variant: c.variant, at: base - frozen * 1000 };
  const cycle = d + 1000;
  return { name: c.name, variant: c.variant, at: base + Math.floor((nowMs - base) / cycle) * cycle };
}

for (const b of bots) b.engine.setActNow(actNow(b.c, performance.now()));

let last = performance.now();
function loop() {
  const n = performance.now();
  const dt = frozen != null ? 1 / 60 : Math.min(0.05, (n - last) / 1000);
  last = n;
  for (const b of bots) {
    const ctx = b.canvas.getContext("2d")!;
    b.engine.act = actNow(b.c, n);
    b.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE + OVERHANG);
    b.engine.draw(ctx, SIZE, SIZE + OVERHANG);
  }
  if (frozen != null) {
    document.title = bots.map((b) => {
      const e = b.engine as unknown as { shown: Act | null; actAmt: number; props: { show: number; stroke: number; fall: number } };
      const age = e.shown && Number.isFinite(actDurationMs(e.shown.name, e.shown.variant)) ? ((performance.now() - e.shown.at) / 1000).toFixed(2) : "-";
      return `${b.c.label}:${e.shown?.name ?? "none"} age=${age} amt=${e.actAmt.toFixed(2)} show=${e.props.show.toFixed(2)}`;
    }).join(" | ");
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
