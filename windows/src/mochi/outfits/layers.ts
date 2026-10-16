// Which part of an outfit goes behind Mochi's body and which in front, and how
// an outfit comes and goes: hats drop onto the head and settle, glasses and the
// scarf slide into place, the bow pops, everything fades as one layer.
// Part of ../outfits.ts, ported from upstream (Louis-CFM/coucou 23c09b9, c97dec1).

import { Ease } from "../../core/anim";
import type { Outfit } from "../wardrobe";
import { crownBack, crownFront } from "./crown";
import { bow, bunnyEars, pumpkin, scarf } from "./faceWear";
import { roundGlasses, sunglasses } from "./glasses";
import { beanie, partyHat, santaHat } from "./hats";
import { bodyOutline, faceTurnedAway, SIMPLIFY_BELOW_R, type Ctx, type Head } from "./head";
import { witchHatBack, witchHatFront } from "./witchHat";

/** Glasses, bow, scarf and pumpkin are on the face: behind the head once it has turned away. */
const ON_FACE: ReadonlySet<Outfit> = new Set(["sunglasses", "roundGlasses", "bow", "scarf", "pumpkin"]);
const HATS: ReadonlySet<Outfit> = new Set(["beanie", "santaHat", "partyHat", "crown", "witchHat"]);

/** At or above this alpha a layer is drawn straight onto the canvas. */
const OPAQUE_ALPHA = 0.999;
/** At or below this alpha the outfit is not drawn at all. */
const MIN_ALPHA = 0.005;
/** The outfit fades over the mailbox morph from START to START + SPAN. */
const MORPH_FADE_START = 0.3;
const MORPH_FADE_SPAN = 0.2;
/** Presence reaches full opacity this many times faster than it reaches 1. */
const PRESENCE_FADE_GAIN = 2.5;
/** How far glasses and the scarf slide in from, in head heights. */
const GLASSES_SLIDE = 0.25;
const SCARF_SLIDE = 0.3;
/** Canvas refuses a zero scale. */
const MIN_SCALE = 0.001;

export interface OutfitState {
  /** 0 = gone, 1 = fully on. Animated by the engine. */
  presence: number;
  /** Mochi's mailbox morph: outfits fade away as he turns into a box. */
  morph: number;
}

let scratch: HTMLCanvasElement | null = null;

/**
 * Draws `fn` at `alpha` as one layer, so overlapping parts don't show through
 * each other while an outfit fades (SwiftUI's drawLayer on macOS).
 */
function withLayer(ctx: Ctx, alpha: number, fn: (c: Ctx) => void) {
  if (alpha >= OPAQUE_ALPHA) {
    ctx.save();
    fn(ctx);
    ctx.restore();
    return;
  }
  const W = ctx.canvas.width;
  const Hh = ctx.canvas.height;
  scratch ??= document.createElement("canvas");
  if (scratch.width < W || scratch.height < Hh) {
    scratch.width = Math.max(scratch.width, W);
    scratch.height = Math.max(scratch.height, Hh);
  }
  const s = scratch.getContext("2d");
  if (!s) return;
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.clearRect(0, 0, W, Hh);
  s.setTransform(ctx.getTransform());
  s.save();
  fn(s);
  s.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= alpha;
  ctx.drawImage(scratch, 0, 0, W, Hh, 0, 0, W, Hh);
  ctx.restore();
}

function drawFace(ctx: Ctx, outfit: Outfit, H: Head, body: Path2D, simple: boolean) {
  switch (outfit) {
    case "sunglasses": sunglasses(ctx, H, body); break;
    case "roundGlasses": roundGlasses(ctx, H, body); break;
    case "scarf": scarf(ctx, H); break;
    case "pumpkin": pumpkin(ctx, H, body, simple); break;
    case "bow": bow(ctx, H); break;
    default: break;
  }
}

/** The front part of `outfit`: a hat's front, or the face wear. */
function drawFront(ctx: Ctx, outfit: Outfit, H: Head, body: Path2D, simple: boolean) {
  switch (outfit) {
    case "beanie": beanie(ctx, H, body, simple); break;
    case "santaHat": santaHat(ctx, H, body); break;
    case "partyHat": partyHat(ctx, H, simple); break;
    case "crown": crownFront(ctx, H, body, simple); break;
    case "witchHat": witchHatFront(ctx, H, body); break;
    default: drawFace(ctx, outfit, H, body, simple);
  }
}

function layerAlpha(st: OutfitState): number {
  const morphFade = 1 - Math.min(1, Math.max(0, (st.morph - MORPH_FADE_START) / MORPH_FADE_SPAN));
  return morphFade * Math.min(1, st.presence * PRESENCE_FADE_GAIN);
}

/** A hat drops onto the head and settles: posP is the eased presence. */
function dropHat(ctx: Ctx, H: Head, posP: number) {
  const hatScale = 0.85 + 0.15 * posP;
  ctx.translate(0, -(1 - posP) * H.ry);
  ctx.scale(hatScale, hatScale);
}

/** Moves the front part of `outfit` to where it is at presence p. */
function placeFront(ctx: Ctx, outfit: Outfit, H: Head, p: number) {
  const posP = Ease.back(p);
  if (HATS.has(outfit)) {
    dropHat(ctx, H, posP);
  } else if (outfit === "sunglasses" || outfit === "roundGlasses") {
    ctx.translate(0, (1 - p) * GLASSES_SLIDE * H.ry);
  } else if (outfit === "scarf") {
    ctx.translate(0, (1 - p) * SCARF_SLIDE * H.ry);
  } else if (outfit === "bow") {
    ctx.scale(Math.max(MIN_SCALE, posP), Math.max(MIN_SCALE, posP));
  }
}

/**
 * The parts behind Mochi's body. `ctx` is in body space (translated to the body
 * centre, tilted and squashed exactly like the body).
 */
export function drawOutfitBehind(ctx: Ctx, outfit: Outfit, H: Head, st: OutfitState) {
  if (outfit === "none") return;
  const alpha = layerAlpha(st);
  if (alpha <= MIN_ALPHA) return;
  const simple = H.R < SIMPLIFY_BELOW_R;
  const body = bodyOutline(H.rx, H.ry);

  if (ON_FACE.has(outfit)) {
    if (faceTurnedAway(H)) withLayer(ctx, alpha, (l) => drawFace(l, outfit, H, body, simple));
    return;
  }
  ctx.save();
  dropHat(ctx, H, Ease.back(st.presence));
  withLayer(ctx, alpha, (l) => {
    if (outfit === "bunnyEars") bunnyEars(l, H);
    else if (outfit === "crown") crownBack(l, H, simple);
    else if (outfit === "witchHat") witchHatBack(l, H);
  });
  ctx.restore();
}

/** The parts in front of Mochi, drawn after the body and the eyes. */
export function drawOutfitFront(ctx: Ctx, outfit: Outfit, H: Head, st: OutfitState) {
  if (outfit === "none" || outfit === "bunnyEars") return;
  if (ON_FACE.has(outfit) && faceTurnedAway(H)) return;
  const alpha = layerAlpha(st);
  if (alpha <= MIN_ALPHA) return;
  const simple = H.R < SIMPLIFY_BELOW_R;
  const body = bodyOutline(H.rx, H.ry);

  ctx.save();
  placeFront(ctx, outfit, H, st.presence);
  withLayer(ctx, alpha, (l) => drawFront(l, outfit, H, body, simple));
  ctx.restore();
}
