// The wardrobe's buttons: a little Mochi wearing each outfit, "auto" with an
// AUTO tag, "none" as a crossed-out circle (drawOutfitIcon on macOS).
// Part of ../outfits.ts, ported from upstream (Louis-CFM/coucou 23c09b9, c97dec1).

import type { Outfit, OutfitSelection } from "../wardrobe";
import { PUMPKIN_BODY } from "./faceWear";
import { bodyOutline, eyeFrames, makeHead, type Ctx, type Head } from "./head";
import { drawOutfitBehind, drawOutfitFront, type OutfitState } from "./layers";
import { lin, rad, roundRect } from "./paint";

const INK = "rgb(26,20,18)";
/** The icon Mochi's radius, in px. */
const ICON_R = 10;
/** His body colours, top and bottom, unless he is a pumpkin. */
const ICON_BODY: readonly [string, string] = ["rgb(237,237,239)", "rgb(196,197,202)"];
/** The AUTO tag: width, height, in px. */
const TAG_W = 14;
const TAG_H = 6.5;
/** The "none" circle's radius, in px. */
const NONE_R = 6.5;

/**
 * One wardrobe button's picture: drawOutfitIcon on macOS. "auto" shows the
 * season's outfit with an AUTO tag, "none" a crossed-out circle.
 */
export function drawWardrobeIcon(ctx: Ctx, size: number, selection: OutfitSelection, seasonal: Outfit, autoLabel: string) {
  ctx.clearRect(0, 0, size, size);
  if (selection === "none") {
    drawNoneIcon(ctx, size);
    return;
  }
  iconMochi(ctx, size, selection === "auto" ? seasonal : selection);
  if (selection !== "auto") return;
  drawAutoTag(ctx, size, autoLabel);
}

/** A crossed-out circle in the middle of the icon. */
function drawNoneIcon(ctx: Ctx, size: number) {
  const r = NONE_R;
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.strokeStyle = "#454850";
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2);
  ctx.moveTo(-r * 0.56, r * 0.56);
  ctx.lineTo(r * 0.56, -r * 0.56);
  ctx.stroke();
  ctx.restore();
}

/** The AUTO tag across the bottom of Mochi's body. */
function drawAutoTag(ctx: Ctx, size: number, autoLabel: string) {
  const R = ICON_R;
  const by = size / 2 + R * 0.62 + R * 0.88 * 0.72;
  const bw = TAG_W;
  const bh = TAG_H;
  ctx.save();
  ctx.translate(size / 2, by);
  roundRect(ctx, { x: -bw / 2, y: -bh / 2, w: bw, h: bh }, bh / 2);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `600 4.2px system-ui, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(autoLabel, 0, 0.2);
  ctx.restore();
}

/** A little Mochi wearing `outfit`, centred in a `size`×`size` icon. */
function iconMochi(ctx: Ctx, size: number, outfit: Outfit) {
  const R = ICON_R;
  const H = makeHead(R);
  const cx = size / 2;
  const cy = size / 2 + R * 0.62;
  const st: OutfitState = { presence: 1, morph: 0 };
  ctx.save();
  ctx.translate(cx, cy);
  drawOutfitBehind(ctx, outfit, H, st);
  const body = bodyOutline(H.rx, H.ry);
  iconBody(ctx, H, body, outfit === "pumpkin" ? PUMPKIN_BODY : ICON_BODY);
  iconEyes(ctx, H, body);
  drawOutfitFront(ctx, outfit, H, st);
  ctx.restore();
}

/** The body: its colour gradient, a dark rim and a light on the top right. */
function iconBody(ctx: Ctx, H: Head, body: Path2D, colours: readonly [string, string]) {
  const R = H.R;
  const [top, bottom] = colours;
  ctx.fillStyle = lin(ctx, [H.rx * 0.7, -H.ry * 0.85, -H.rx * 0.8, H.ry * 0.9], [[0, top], [1, bottom]]);
  ctx.fill(body);
  ctx.fillStyle = rad(ctx, [0, 0, R * 0.15, R * 1.25], [[0, "rgba(0,0,0,0)"], [0.6, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,0.2)"]]);
  ctx.fill(body);
  ctx.fillStyle = rad(ctx, [H.rx * 0.34, -H.ry * 0.46, 0, R * 0.42], [[0, "rgba(255,255,255,0.55)"], [1, "rgba(255,255,255,0)"]]);
  ctx.fill(body);
}

/** The engine's eyes, as rounded bars, clipped to the body. */
function iconEyes(ctx: Ctx, H: Head, body: Path2D) {
  ctx.save();
  ctx.clip(body);
  ctx.fillStyle = INK;
  for (const e of eyeFrames(H)) {
    if (!e.visible) continue;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.scale(e.fx, e.fy);
    const hh = Math.max(e.h, e.w * 0.3);
    roundRect(ctx, { x: -e.w / 2, y: -hh / 2, w: e.w, h: hh }, Math.min(e.w / 2, hh / 2));
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}
