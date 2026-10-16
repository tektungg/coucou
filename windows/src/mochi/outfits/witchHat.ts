// The witch hat: a wide wobbly brim (whole behind the head, its front half
// again in front) and a tall cone whose tip bends over, with a band and buckle.
// Part of ../outfits.ts, ported from upstream (Louis-CFM/coucou 23c09b9, c97dec1).

import { frontArc, proj, ringR, type Ctx, type Head, type P3, type Pt } from "./head";
import { capShadow, closedPath, lin, polyline, roundRect } from "./paint";

/** The brim: height on the head, radius, steps round it. */
const BRIM_Y = 0.7;
const BRIM_R = 1.42;
const BRIM_STEPS = 120;
/** The cone's base ring: radius, height on the head. */
const CONE_BASE_R = 0.62;
const CONE_BASE_Y = 0.74;
/** The band overshoots the cone's sides by this many px, hidden by the clip. */
const BAND_OVERSHOOT = 2;
/** Arc points this close outside the cone's base still count as its front. */
const BASE_SLACK = 1;

/** The cone: base ends (bl, br) and middle (c), the bend (top), the tip, the band's front (fc). */
interface WitchCone {
  bl: P3;
  br: P3;
  c: P3;
  top: Pt;
  tip: Pt;
  fc: P3;
  path: Path2D;
}

function witchBrim(H: Head): P3[] {
  const y = BRIM_Y;
  const rr = BRIM_R;
  const pts: P3[] = [];
  for (let i = 0; i <= BRIM_STEPS; i++) {
    const a = -Math.PI + (i / BRIM_STEPS) * 2 * Math.PI;
    const wob = 1 + 0.035 * Math.sin(a * 3 + 0.6);
    const droop = -0.1 * Math.pow(Math.abs(Math.sin(a)), 2); // the edges droop a little
    pts.push(proj(H, [rr * wob * Math.sin(a), y + droop, rr * wob * Math.cos(a)]));
  }
  return pts;
}

/** The whole brim, behind the head; witchHatFront paints its front half again. */
export function witchHatBack(ctx: Ctx, H: Head) {
  ctx.fillStyle = lin(ctx, [0, -H.ry, 0, -H.ry * 0.4], [[0, "#2A0A4F"], [1, "#3B0F6B"]]);
  ctx.fill(closedPath(witchBrim(H)));
}

export function witchHatFront(ctx: Ctx, H: Head, body: Path2D) {
  capShadow(ctx, H, body, 0.5, "rgba(40,0,70,0.10)");
  witchBrimFront(ctx, H);
  const cone = witchCone(H);
  const { bl, br, top } = cone;
  ctx.fillStyle = lin(ctx, [bl.x, top.y, br.x, bl.y], [[0, "#7C3AED"], [0.55, "#4C1D95"], [1, "#2E1065"]]);
  ctx.fill(cone.path);

  ctx.save();
  ctx.clip(cone.path);
  ctx.fillStyle = lin(ctx, [bl.x, 0, br.x, 0], [[0, "rgba(255,255,255,0.22)"], [0.4, "rgba(255,255,255,0)"], [1, "rgba(0,0,0,0.15)"]]);
  ctx.fill(cone.path);
  witchCrease(ctx, H, top);
  witchBand(ctx, H, cone);
  ctx.restore();

  witchBuckle(ctx, H, cone.fc);
}

/** The brim over the head, with a light along its front edge. */
function witchBrimFront(ctx: Ctx, H: Head) {
  const all = witchBrim(H);
  const fr = all.filter((p) => p.z >= 0).sort((a, b) => a.x - b.x);
  ctx.fillStyle = lin(ctx, [0, -H.ry * 0.9, 0, -H.ry * 0.3], [[0, "#5B21B6"], [1, "#3B0764"]]);
  ctx.fill(closedPath(all));
  if (fr.length <= 1) return;
  polyline(ctx, fr);
  ctx.strokeStyle = "rgba(190,150,255,0.35)";
  ctx.lineWidth = H.R * 0.035;
  ctx.lineCap = "round";
  ctx.stroke();
}

/** Cone: base ring r = 0.62 at y = 0.74, tall apex, the tip bends over. */
function witchCone(H: Head): WitchCone {
  const baseR = CONE_BASE_R;
  const by = CONE_BASE_Y;
  const bl = proj(H, [-baseR, by, 0]);
  const br = proj(H, [baseR, by, 0]);
  const c = proj(H, [0, by, 0]);
  const lean = 0.1 + H.physDx * 0.15;
  const top = { x: c.x + H.rx * 0.18 + Math.sin(lean) * H.ry * 0.3, y: c.y - H.ry * 1.25 };
  const tip = { x: top.x + H.rx * (0.45 + H.physDx * 0.25), y: top.y + H.ry * (0.22 + H.physDy * 0.1) };
  const fc = proj(H, [0, by, baseR]);
  return { bl, br, c, top, tip, fc, path: witchConePath(H, { bl, br, c, top, tip }) };
}

/** Up from the left of the base to the bend, out to the tip, back down, along the base's front. */
function witchConePath(H: Head, k: Omit<WitchCone, "fc" | "path">): Path2D {
  const { bl, br, c, top, tip } = k;
  const by = CONE_BASE_Y;
  const capFront = frontArc(H, by, CONE_BASE_R / ringR(by)).filter((q) => q.x >= bl.x - BASE_SLACK && q.x <= br.x + BASE_SLACK);
  const cone = new Path2D();
  cone.moveTo(bl.x, bl.y);
  cone.bezierCurveTo(bl.x + H.rx * 0.12, bl.y - H.ry * 0.5, top.x - H.rx * 0.28, top.y + H.ry * 0.25, top.x - H.rx * 0.02, top.y - H.ry * 0.02);
  cone.quadraticCurveTo(top.x + H.rx * 0.25, top.y - H.ry * 0.08, tip.x, tip.y);
  cone.quadraticCurveTo(top.x + H.rx * 0.22, top.y + H.ry * 0.08, top.x + H.rx * 0.14, top.y + H.ry * 0.22);
  cone.bezierCurveTo(br.x - H.rx * 0.18, c.y - H.ry * 0.45, br.x - H.rx * 0.02, br.y - H.ry * 0.2, br.x, br.y);
  for (let i = capFront.length - 1; i >= 0; i--) cone.lineTo(capFront[i].x, capFront[i].y);
  cone.closePath();
  return cone;
}

/** The crease where the tip bends. */
function witchCrease(ctx: Ctx, H: Head, top: Pt) {
  ctx.beginPath();
  ctx.moveTo(top.x - H.rx * 0.05, top.y + H.ry * 0.05);
  ctx.quadraticCurveTo(top.x + H.rx * 0.1, top.y + H.ry * 0.12, top.x + H.rx * 0.2, top.y + H.ry * 0.06);
  ctx.strokeStyle = "rgba(20,0,40,0.35)";
  ctx.lineWidth = H.R * 0.05;
  ctx.lineCap = "round";
  ctx.stroke();
}

/** The orange band, just above the base. */
function witchBand(ctx: Ctx, H: Head, cone: WitchCone) {
  const { bl, br, fc } = cone;
  const lift = H.ry * 0.11;
  ctx.beginPath();
  ctx.moveTo(bl.x - BAND_OVERSHOOT, bl.y - lift);
  ctx.quadraticCurveTo(fc.x, 2 * (fc.y - lift) - (bl.y + br.y) / 2, br.x + BAND_OVERSHOOT, br.y - lift);
  ctx.strokeStyle = "#F97316";
  ctx.lineWidth = H.ry * 0.17;
  ctx.lineCap = "butt";
  ctx.stroke();
}

/** The buckle on the band, facing the viewer. */
function witchBuckle(ctx: Ctx, H: Head, fc: P3) {
  const bw = H.R * 0.2;
  const bh = H.R * 0.16;
  ctx.save();
  ctx.translate(fc.x, fc.y - H.ry * 0.11);
  roundRect(ctx, { x: -bw / 2, y: -bh / 2, w: bw, h: bh }, bh * 0.25);
  ctx.fillStyle = "#FCD34D";
  ctx.fill();
  roundRect(ctx, { x: -bw / 2 + bw * 0.24, y: -bh / 2 + bh * 0.28, w: bw * 0.52, h: bh * 0.44 }, bh * 0.1);
  ctx.fillStyle = "#C2410C";
  ctx.fill();
  ctx.restore();
}
