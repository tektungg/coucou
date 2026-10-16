// The soft bits of the hats: pompoms and the fuzzy trim of the Santa hat.
// Part of ../outfits.ts, ported from upstream (Louis-CFM/coucou 23c09b9, c97dec1).

import type { Ctx, Pt } from "./head";
import { polyline, rad } from "./paint";

/** Little balls round a pompom's rim. */
const POMPOM_BALLS = 11;
/** The fuzzy trim gets about this many tufts along its length. */
const FUZZ_TUFTS = 16;

/** A fluffy ball of radius r centred on `at`. */
export function pompom(ctx: Ctx, at: Pt, r: number, base = "#FFFFFF", shade = "#D5D9E2") {
  ctx.save();
  ctx.translate(at.x, at.y);
  const n = POMPOM_BALLS;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const br = r * (0.34 + 0.06 * Math.sin(i * 2.3));
    const bx = Math.cos(a) * r * 0.78;
    const by = Math.sin(a) * r * 0.78;
    ctx.fillStyle = rad(ctx, [bx - br * 0.4, by - br * 0.5, 0, br * 1.3], [[0, base], [1, shade]]);
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = rad(ctx, [-r * 0.3, -r * 0.35, 0, r * 1.05], [[0, base], [0.7, base], [1, shade]]);
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Fuzzy band along a polyline (the Santa hat's trim). */
export function fuzzyBand(ctx: Ctx, arc: Pt[], thick: number, base = "#FFFFFF", shade = "#DADDE4") {
  if (arc.length < 2) return;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  polyline(ctx, arc);
  ctx.strokeStyle = shade;
  ctx.lineWidth = thick;
  ctx.stroke();
  polyline(ctx, arc);
  ctx.strokeStyle = base;
  ctx.lineWidth = thick * 0.78;
  ctx.stroke();
  const step = Math.max(2, Math.floor(arc.length / FUZZ_TUFTS));
  for (let i = 0; i < arc.length; i += step) {
    const q = arc[i];
    const r = thick * (0.32 + 0.1 * Math.sin(i * 1.7));
    ctx.fillStyle = rad(ctx, [q.x - r * 0.3, q.y - thick * 0.35 - r * 0.3, 0, r * 1.2], [[0, base], [1, shade]]);
    ctx.beginPath();
    ctx.arc(q.x, q.y - thick * 0.32, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
