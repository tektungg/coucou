// The soft hats: the beanie, the Santa hat and the party hat. Each is drawn in
// front of the head; its shadow on the head is painted first.
// Part of ../outfits.ts, ported from upstream (Louis-CFM/coucou 23c09b9, c97dec1).

import {
  bodyOutline, capClip, frontArc, frontSilhouette, invert, proj, surf, visibleMeridian,
  type Ctx, type Head, type P3, type Pt,
} from "./head";
import { capShadow, lin, polyline, rad } from "./paint";
import { fuzzyBand, pompom } from "./soft";

// ── Beanie ────────────────────────────────────────────────────────────────────

const BEANIE_S = 1.035;
/** Bottom edge of the cuff, as a head height. */
const BEANIE_EDGE = 0.42;
/** Top of the cuff, where the knit starts. */
const BEANIE_CUFF = 0.58;
/** The cuff sits a little proud of the knit. */
const CUFF_GROW = 1.04;
/** Knit ribs each side of the middle, and the steps along each. */
const KNIT_RIBS = 6;
const KNIT_RIB_STEPS = 16;
/** Ribs of the cuff each side of the middle. */
const CUFF_RIBS = 14;

export function beanie(ctx: Ctx, H: Head, body: Path2D, simple: boolean) {
  const s = BEANIE_S;
  const head = bodyOutline(H.rx * s, H.ry * s);
  // shadow on the head under the cuff
  capShadow(ctx, H, body, BEANIE_EDGE - 0.12, "rgba(30,40,70,0.10)");
  beanieKnit(ctx, H, head, simple);
  beanieCuff(ctx, H);
  beanieHighlight(ctx, H, head);
  // pompom on a short spring
  const top = proj(H, [0, 1.08 * s, 0]);
  const at = { x: top.x + H.physDx * H.rx * 0.25, y: top.y - H.R * 0.12 + H.physDy * H.ry * 0.15 };
  pompom(ctx, at, H.R * 0.24);
}

/** The knitted body above the cuff, with its ribs when there is room. */
function beanieKnit(ctx: Ctx, H: Head, head: Path2D, simple: boolean) {
  ctx.save();
  ctx.clip(capClip(H, BEANIE_CUFF, BEANIE_S));
  ctx.fillStyle = lin(ctx, [H.rx * 0.5, -H.ry * 1.1, -H.rx * 0.6, H.ry * 0.2], [[0, "#7DB6FF"], [1, "#2F6FE0"]]);
  ctx.fill(head);
  if (!simple) knitRibs(ctx, H, head);
  ctx.restore();
}

/** The vertical ribs of the knit, from the cuff up over the top. */
function knitRibs(ctx: Ctx, H: Head, head: Path2D) {
  ctx.clip(head);
  ctx.strokeStyle = "rgba(20,50,140,0.16)";
  ctx.lineWidth = H.R * 0.045;
  ctx.lineCap = "round";
  for (let k = -KNIT_RIBS; k <= KNIT_RIBS; k++) {
    const lon = k * 0.24;
    const span = 1.05 - BEANIE_CUFF;
    const pts = visibleMeridian(H, { lon, s: BEANIE_S, y0: BEANIE_CUFF, span, steps: KNIT_RIB_STEPS });
    if (pts.length < 2) continue;
    polyline(ctx, pts);
    ctx.stroke();
  }
}

/** The cuff: the band between BEANIE_EDGE and BEANIE_CUFF, with short ribs. */
function beanieCuff(ctx: Ctx, H: Head) {
  const s = BEANIE_S;
  const cuffHead = bodyOutline(H.rx * s * CUFF_GROW, H.ry * s * CUFF_GROW);
  const sc = s * CUFF_GROW;
  ctx.save();
  ctx.clip(capClip(H, BEANIE_EDGE, sc));
  ctx.clip(invert(capClip(H, BEANIE_CUFF, sc), H), "evenodd");
  ctx.fillStyle = lin(ctx, [0, -H.ry * 0.6, 0, -H.ry * 0.2], [[0, "#3C7BEA"], [1, "#2257C4"]]);
  ctx.fill(cuffHead);
  ctx.clip(cuffHead);
  ctx.strokeStyle = "rgba(10,30,100,0.22)";
  ctx.lineWidth = H.R * 0.035;
  for (let k = -CUFF_RIBS; k <= CUFF_RIBS; k++) {
    const lon = k * 0.115;
    const a = proj(H, surf(BEANIE_EDGE, lon, sc));
    const b = proj(H, surf(BEANIE_CUFF, lon, sc));
    if (a.z < 0) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** A soft light on the top of the knit. */
function beanieHighlight(ctx: Ctx, H: Head, head: Path2D) {
  ctx.save();
  ctx.clip(capClip(H, BEANIE_CUFF, BEANIE_S));
  ctx.clip(head);
  ctx.fillStyle = rad(ctx, [H.rx * 0.3, -H.ry * 0.85, 0, H.R * 0.45], [[0, "rgba(255,255,255,0.35)"], [1, "rgba(255,255,255,0)"]]);
  ctx.fill(head);
  ctx.restore();
}

// ── Santa hat ─────────────────────────────────────────────────────────────────

const SANTA_S = 1.05;
/** Where the trim sits, as a head height. */
const SANTA_EDGE = 0.52;
/** The two folds: start and end along the flop, and width (fraction of R). */
const SANTA_FOLDS = [[0.15, 0.55, 0.1], [0.45, 0.85, 0.08]];

/** The hat's outline and the points its parts hang from. */
interface SantaShape {
  /** Front arc of the trim, left → right. */
  arc: P3[];
  peak: Pt;
  tip: Pt;
  bag: Path2D;
}

export function santaHat(ctx: Ctx, H: Head, body: Path2D) {
  const hat = santaShape(H);
  if (!hat) return;
  capShadow(ctx, H, body, SANTA_EDGE - 0.14, "rgba(120,10,10,0.10)");
  ctx.fillStyle = lin(ctx, [-H.rx * 0.6, -H.ry * 1.6, H.rx * 0.7, -H.ry * 0.3], [[0, "#FF6B6B"], [0.55, "#E53935"], [1, "#B71C1C"]]);
  ctx.fill(hat.bag);
  santaFolds(ctx, H, hat);
  fuzzyBand(ctx, hat.arc, H.R * 0.3);
  pompom(ctx, { x: hat.tip.x, y: hat.tip.y + H.R * 0.04 }, H.R * 0.22);
}

function santaShape(H: Head): SantaShape | null {
  const arc = frontArc(H, SANTA_EDGE, SANTA_S);
  if (arc.length === 0) return null;
  const crown = proj(H, [0, 1.05, 0]);
  // the tip flops to the right and down, plus the spring lag
  const tip = { x: crown.x + H.rx * (0.95 + H.physDx * 0.35), y: crown.y + H.ry * (0.05 + H.physDy * 0.2) };
  const peak = { x: crown.x + H.rx * 0.25, y: crown.y - H.ry * 0.62 };
  return { arc, peak, tip, bag: santaBag(H, arc, peak, tip) };
}

/** The bag of the hat: up from the trim to the peak, flopping over to the tip. */
function santaBag(H: Head, arc: P3[], peak: Pt, tip: Pt): Path2D {
  const L = arc[0];
  const Rt = arc[arc.length - 1];
  const bag = new Path2D();
  bag.moveTo(L.x, L.y);
  bag.bezierCurveTo(L.x - H.rx * 0.05, L.y - H.ry * 0.7, peak.x - H.rx * 0.55, peak.y - H.ry * 0.05, peak.x, peak.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.05, peak.y - H.ry * 0.02, tip.x, tip.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.12, tip.y - H.ry * 0.22, peak.x + H.rx * 0.18, peak.y + H.ry * 0.32);
  bag.bezierCurveTo(Rt.x + H.rx * 0.05, peak.y + H.ry * 0.45, Rt.x + H.rx * 0.08, Rt.y - H.ry * 0.35, Rt.x, Rt.y);
  for (let i = arc.length - 1; i >= 0; i--) bag.lineTo(arc[i].x, arc[i].y);
  bag.closePath();
  return bag;
}

/** Folds following the flop, and a light on the peak. */
function santaFolds(ctx: Ctx, H: Head, hat: SantaShape) {
  const { arc, peak, tip } = hat;
  const width = arc[arc.length - 1].x - arc[0].x;
  ctx.save();
  ctx.clip(hat.bag);
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(90,0,0,0.20)";
  for (const [a, b, w] of SANTA_FOLDS) {
    ctx.beginPath();
    ctx.moveTo(peak.x - H.rx * 0.1 + width * a * 0.3, peak.y + H.ry * 0.15);
    ctx.quadraticCurveTo(peak.x + H.rx * 0.35, peak.y + H.ry * (0.05 + a * 0.3), tip.x - H.rx * (0.45 - b * 0.3), tip.y - H.ry * 0.12);
    ctx.lineWidth = H.R * w;
    ctx.stroke();
  }
  ctx.fillStyle = rad(ctx, [peak.x - H.rx * 0.25, peak.y + H.ry * 0.05, 0, H.R * 0.5], [[0, "rgba(255,255,255,0.32)"], [1, "rgba(255,255,255,0)"]]);
  ctx.fill(hat.bag);
  ctx.restore();
}

// ── Party hat ─────────────────────────────────────────────────────────────────

/** The cone's base ring: height on the head, radius. */
const PARTY_BASE_Y = 0.82;
const PARTY_BASE_R = 0.42;
/** The base ring sits this far right of the head's middle. */
const PARTY_OFFSET_X = 0.16;
const PARTY_RIM_STEPS = 48;
/** Dots on the cone: t up from the base to the apex, u across (-1…1). */
const PARTY_DOTS = [[0.25, -0.35], [0.3, 0.3], [0.55, -0.05], [0.72, 0.28], [0.8, -0.3], [0.45, 0.6], [0.48, -0.65]];

/** The cone: the ends of its base, its apex, the front of its rim, its outline. */
interface PartyCone {
  left: P3;
  right: P3;
  apex: Pt;
  front: P3[];
  path: Path2D;
}

export function partyHat(ctx: Ctx, H: Head, simple: boolean) {
  const cone = partyCone(H);
  const { left, right, apex, path } = cone;
  ctx.fillStyle = lin(ctx, [left.x, apex.y, right.x, left.y], [[0, "#FF9BD0"], [0.5, "#F15BAE"], [1, "#C2187A"]]);
  ctx.fill(path);

  ctx.save();
  ctx.clip(path);
  if (!simple) partyDots(ctx, H, cone);
  ctx.fillStyle = lin(ctx, [left.x, 0, right.x, 0], [[0, "rgba(255,255,255,0.28)"], [0.35, "rgba(255,255,255,0)"], [1, "rgba(80,0,40,0.18)"]]);
  ctx.fill(path);
  ctx.restore();

  partyRim(ctx, H, cone.front);
  pompom(ctx, { x: apex.x, y: apex.y - H.R * 0.04 }, H.R * 0.16, "#FFE27A", "#F2B705");
}

function partyCone(H: Head): PartyCone {
  const baseY = PARTY_BASE_Y;
  const baseR = PARTY_BASE_R;
  const lean = -0.24 + H.physDx * 0.12;
  const c = proj(H, [PARTY_OFFSET_X, baseY + 0.06, 0]);
  const rim: P3[] = [];
  for (let i = 0; i <= PARTY_RIM_STEPS; i++) {
    const a = (i / PARTY_RIM_STEPS) * Math.PI * 2;
    rim.push(proj(H, [PARTY_OFFSET_X + baseR * Math.sin(a), baseY + 0.06, baseR * Math.cos(a)]));
  }
  const left = rim.reduce((m, q) => (q.x < m.x ? q : m));
  const right = rim.reduce((m, q) => (q.x > m.x ? q : m));
  const h = H.ry * 1.6;
  const apex = { x: c.x + Math.sin(lean) * h, y: c.y - Math.cos(lean) * h };
  const front = frontSilhouette(rim);
  return { left, right, apex, front, path: partyConePath(H, { left, right, apex, front }) };
}

/** Up the left side to a rounded apex, down the right, back along the rim's front. */
function partyConePath(H: Head, k: Omit<PartyCone, "path">): Path2D {
  const { left, right, apex, front } = k;
  const cone = new Path2D();
  cone.moveTo(left.x, left.y);
  cone.quadraticCurveTo((left.x + apex.x) / 2 - H.rx * 0.06, (left.y + apex.y) / 2, apex.x - H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo(apex.x, apex.y - H.R * 0.03, apex.x + H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo((right.x + apex.x) / 2 + H.rx * 0.06, (right.y + apex.y) / 2, right.x, right.y);
  for (let i = front.length - 1; i >= 0; i--) cone.lineTo(front[i].x, front[i].y);
  cone.closePath();
  return cone;
}

/** White polka dots, smaller toward the apex. */
function partyDots(ctx: Ctx, H: Head, cone: PartyCone) {
  const { left, right, apex } = cone;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  for (const [t, u] of PARTY_DOTS) {
    const bx = left.x + (right.x - left.x) * (0.5 + u * 0.5);
    const by = left.y + (right.y - left.y) * (0.5 + u * 0.5);
    const x = bx + (apex.x - bx) * (1 - t);
    const y = by + (apex.y - by) * (1 - t);
    const r = H.R * 0.075 * (0.6 + t * 0.5);
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The gold trim along the front of the rim. */
function partyRim(ctx: Ctx, H: Head, front: P3[]) {
  if (front.length <= 1) return;
  polyline(ctx, front);
  ctx.strokeStyle = "#FFD84D";
  ctx.lineWidth = H.R * 0.07;
  ctx.lineCap = "round";
  ctx.stroke();
}
