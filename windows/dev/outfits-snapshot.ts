// Dev harness: a deterministic picture of every outfit on Mochi's head, turned
// and tilted, large and small (below R = 16 the simplified drawing), fading in,
// plus every wardrobe icon and the pumpkin body colours. It checks that a
// refactor of mochi/outfits.ts changes no pixel. The clock is frozen and
// Math.random seeded before the outfits load, so two runs of the same code draw
// the same bytes. Not part of the app bundle. With a dev server, open
// /dev/outfits-snapshot.html; `document.title` reads "ready" once all is drawn.

// Type-only imports are erased: nothing loads before the clock is frozen.
import type { Head, OutfitState } from "../src/mochi/outfits";
import type { Outfit } from "../src/mochi/wardrobe";

let seed = 0x9e3779b9;
/** mulberry32: a tiny seeded PRNG in place of Math.random. */
Math.random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const FROZEN_MS = 100_000;
Object.defineProperty(performance, "now", { value: () => FROZEN_MS, configurable: true });

const { makeHead, drawOutfitBehind, drawOutfitFront, drawWardrobeIcon, PUMPKIN_BODY } = await import("../src/mochi/outfits");
const { OUTFIT_SELECTIONS } = await import("../src/mochi/wardrobe");

/** One drawn head: its geometry and how far the outfit is on. */
interface Case {
  R: number;
  yaw?: number;
  pitch?: number;
  physDx?: number;
  physDy?: number;
  presence?: number;
  morph?: number;
}

const BIG_R = 24;
const SMALL_R = 12;
const BIG_W = 80;
const SMALL_W = 44;
const ROW_H = 100;
const CENTRE_Y = 62;
const LABEL_W = 70;
const BODY_FILL = "#8899AA";
const ICON_SIZE = 28;
const ICON_SCALE = 2;
const ICON_STEP = 64;
/** Far enough round that the face is behind the head: face wear draws behind the body. */
const TURNED_AWAY_YAW = 2.4;

const POSES: [number, number][] = [[0, 0], [0.5, 0], [-0.9, 0], [0, 0.3], [0.5, 0.3], [-0.9, 0.3]];
const CASES: Case[] = [
  ...POSES.map(([yaw, pitch]) => ({ R: BIG_R, yaw, pitch })),
  { R: BIG_R, presence: 0.5 },
  { R: BIG_R, yaw: 0.3, pitch: -0.2, physDx: 0.6, physDy: -0.4 },
  { R: BIG_R, morph: 0.4 },
  { R: BIG_R, yaw: TURNED_AWAY_YAW },
  ...POSES.map(([yaw, pitch]) => ({ R: SMALL_R, yaw, pitch })),
];

const OUTFITS = OUTFIT_SELECTIONS.filter((s) => s !== "auto" && s !== "none") as Outfit[];

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
ctx.font = "10px system-ui";

/** Draws one head wearing `outfit` at (x, y): behind parts, a plain body, front parts. */
function drawCell(outfit: Outfit, c: Case, x: number, y: number) {
  const H: Head = makeHead(c.R, c.yaw ?? 0, c.pitch ?? 0, c.physDx ?? 0, c.physDy ?? 0);
  const st: OutfitState = { presence: c.presence ?? 1, morph: c.morph ?? 0 };
  ctx.save();
  ctx.translate(x, y);
  drawOutfitBehind(ctx, outfit, H, st);
  ctx.beginPath();
  ctx.ellipse(0, 0, H.rx, H.ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = BODY_FILL;
  ctx.fill();
  drawOutfitFront(ctx, outfit, H, st);
  ctx.restore();
}

OUTFITS.forEach((outfit, row) => {
  const top = row * ROW_H;
  ctx.fillStyle = "#9aa";
  ctx.fillText(outfit, 4, top + CENTRE_Y);
  let x = LABEL_W;
  for (const c of CASES) {
    const w = c.R === BIG_R ? BIG_W : SMALL_W;
    drawCell(outfit, c, x + w / 2, top + CENTRE_Y);
    x += w;
  }
});

const iconTop = OUTFITS.length * ROW_H + 10;
OUTFIT_SELECTIONS.forEach((selection, i) => {
  ctx.save();
  ctx.translate(4 + i * ICON_STEP, iconTop);
  ctx.scale(ICON_SCALE, ICON_SCALE);
  drawWardrobeIcon(ctx, ICON_SIZE, selection, "witchHat", "AUTO");
  ctx.restore();
});

const swatchTop = iconTop + ICON_STEP + 10;
PUMPKIN_BODY.forEach((colour, i) => {
  ctx.fillStyle = colour;
  ctx.fillRect(4 + i * 60, swatchTop, 50, 30);
});

document.title = "ready";
