// Dev page: the Music acts (mochi/musicProps.ts, acts.ts "music" and
// "musicCue") on the real Mochi through the real act pipeline, at a roomy size
// and at the island's own bot canvas size, so a prop that would be clipped
// shows here. The one-shots replay. Not part of the app bundle. With
// `npm run dev`, open http://127.0.0.1:1420/dev/music-acts-preview.html

import { BotEngine, hexToRGB } from "../../src/mochi/engine";
import { actDurationMs, isOneShot, type Act, type ActName } from "../../src/mochi/acts";

interface Case { label: string; when: string; act: ActName; variant: string }

const CASES: Case[] = [
  { label: "Playing", when: "a song plays", act: "music", variant: "playing" },
  { label: "Singing", when: "the synced lyrics are being sung", act: "music", variant: "singing" },
  { label: "Paused", when: "a song is there, paused", act: "music", variant: "paused" },
  { label: "Track change", when: "a new track starts playing (one-shot)", act: "musicCue", variant: "change" },
  { label: "Resume", when: "play after a pause (one-shot)", act: "musicCue", variant: "resume" },
];

const MUSIC_GREEN = "#1DB954";
const OVERHANG = 40; // island.ts BOT_OVERHANG
const BIG_W = 230;
/** island.ts: canvas = diameter / 0.6 wide; Home's Mochi is 58 px. */
const ISLAND_W = Math.round(58 / 0.6);
const REPLAY_GAP_MS = 900;
const dpr = Math.max(2, window.devicePixelRatio || 1);

interface Bot { engine: BotEngine; canvas: HTMLCanvasElement; w: number; c: Case }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function makeBot(c: Case, w: number): Bot {
  const canvas = el("canvas");
  canvas.width = w * dpr;
  canvas.height = (w + OVERHANG) * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${w + OVERHANG}px`;
  const engine = new BotEngine();
  engine.bodyColor = hexToRGB(MUSIC_GREEN);
  engine.particleOverhang = OVERHANG;
  return { engine, canvas, w, c };
}

function build(): Bot[] {
  const grid = document.getElementById("grid")!;
  const bots: Bot[] = [];
  for (const c of CASES) {
    const big = makeBot(c, BIG_W);
    const small = makeBot(c, ISLAND_W);
    bots.push(big, small);
    const island = el("div", "island");
    island.append(small.canvas, el("small", "", "island size"));
    const stage = el("div", "stage");
    stage.append(big.canvas, island);
    const cell = el("div", "cell");
    const head = el("div", "meta");
    head.append(el("span", "code", `${c.act}:${c.variant}`), el("b", "", c.label), el("p", "", `When ${c.when}.`));
    cell.append(stage, head);
    grid.append(cell);
  }
  return bots;
}

/** One-shots restart every (duration + gap); continuous acts follow the free clock. */
function actNow(c: Case, base: number, now: number): Act {
  if (!isOneShot(c.act)) return { name: c.act, variant: c.variant, at: 0 };
  const cycle = actDurationMs(c.act, c.variant) + REPLAY_GAP_MS;
  return { name: c.act, variant: c.variant, at: base + Math.floor((now - base) / cycle) * cycle };
}

const bots = build();
const base = performance.now();
for (const b of bots) b.engine.setActNow(actNow(b.c, base, base));
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
