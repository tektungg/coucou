// Dev harness: the Claude Code acts (mochi/claudeProps.ts) on the real Mochi,
// through the real act pipeline (engine.act), at a roomy size and at the
// island's own bot canvas size (97 px wide plus the 40 px overhang, as
// island.ts draws it), so a prop that would be clipped shows here.
// Not part of the app bundle. With `npm run dev`, open
// http://127.0.0.1:1420/dev/claude-acts-preview.html

import { BotEngine } from "../../src/mochi/engine";
import { actDurationMs, isOneShot, type Act, type ActName } from "../../src/mochi/acts";
import type { BotStateName } from "../../src/core/layout";

interface Case { label: string; state: BotStateName; name: ActName; variant: string }

const CASES: Case[] = [
  { label: "idle", state: "idle", name: "claude", variant: "idle" },
  { label: "thinking", state: "thinking", name: "claude", variant: "thinking" },
  { label: "working · Edit / Write", state: "working", name: "claude", variant: "working:edit" },
  { label: "working · Bash", state: "working", name: "claude", variant: "working:bash" },
  { label: "working · Read / Grep / Web", state: "working", name: "claude", variant: "working:read" },
  { label: "question", state: "question", name: "claude", variant: "question" },
  { label: "approval", state: "approval", name: "claude", variant: "approval" },
  { label: "ratelimit", state: "ratelimit", name: "claude", variant: "ratelimit" },
  { label: "error · while it stands", state: "error", name: "claude", variant: "error" },
  { label: "error · one-shot", state: "error", name: "claudeEnd", variant: "error" },
  { label: "finished · one-shot", state: "finished", name: "claudeEnd", variant: "finished" },
];

/** island.ts: canvas = diameter / 0.6 wide, plus BOT_OVERHANG; Home's Mochi is 58 px. */
const ISLAND_W = Math.round(58 / 0.6);
const OVERHANG = 40;
const BIG_W = 220;
const dpr = Math.max(2, window.devicePixelRatio || 1);
/** One-shots replay with a pause between runs. */
const REPLAY_GAP_MS = 900;

interface Bot { engine: BotEngine; canvas: HTMLCanvasElement; w: number; c: Case }

function makeCanvas(w: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w * dpr;
  canvas.height = (w + OVERHANG) * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${w + OVERHANG}px`;
  return canvas;
}

function makeBot(c: Case, w: number): Bot {
  const engine = new BotEngine();
  engine.setState(c.state, true);
  engine.particleOverhang = OVERHANG;
  return { engine, canvas: makeCanvas(w), w, c };
}

function actNow(c: Case, base: number, now: number): Act {
  if (!isOneShot(c.name)) return { name: c.name, variant: c.variant, at: 0 };
  const cycle = actDurationMs(c.name, c.variant) + REPLAY_GAP_MS;
  return { name: c.name, variant: c.variant, at: base + Math.floor((now - base) / cycle) * cycle };
}

function build(): Bot[] {
  const grid = document.getElementById("grid")!;
  const bots: Bot[] = [];
  for (const c of CASES) {
    const big = makeBot(c, BIG_W);
    const small = makeBot(c, ISLAND_W);
    const cell = document.createElement("div");
    cell.className = "cell";
    const label = document.createElement("b");
    label.textContent = c.label;
    const pair = document.createElement("div");
    pair.className = "pair";
    const island = document.createElement("div");
    island.className = "island";
    island.append(small.canvas);
    pair.append(big.canvas, island);
    cell.append(label, pair);
    grid.append(cell);
    bots.push(big, small);
  }
  return bots;
}

const bots = build();
const base = performance.now();
let last = base;
function loop(now: number) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  for (const b of bots) {
    b.engine.act = actNow(b.c, base, now);
    b.engine.update(dt);
    const x = b.canvas.getContext("2d")!;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, b.w, b.w + OVERHANG);
    b.engine.draw(x, b.w, b.w + OVERHANG);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
