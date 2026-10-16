// The 1080 × 1920 image of the week, drawn once into an offscreen canvas.
// Port of RecapShareImageView in WeeklyRecapView.swift, from upstream
// (Louis-CFM/coucou 9806b66), split into one function per block. Same colours,
// sizes and order; Mochi comes from the island's own engine.

import { BotEngine } from "../mochi/engine";
import { formatCount, formatDuration, weekRangeLabel, type WeeklySummary } from "./summary";

export const SHARE_W = 1080;
export const SHARE_H = 1920;

const FONT = `system-ui, "Segoe UI Variable Display", "Segoe UI", "Cantarell", "Ubuntu", sans-serif`;
const MONO = `"Cascadia Mono", "Consolas", "DejaVu Sans Mono", ui-monospace, monospace`;

const INK = "#F1F2F4";
const DIM = "#8E939C";
const INDIGO_TEXT = "#818CF8";
const PLUS = "#4ADE80";
const MINUS = "#F87171";

/** Strings drawn into the image, in one place. */
const T = {
  title: "Weekly recap",
  timeCoding: "TIME CODING",
  sessions: "SESSIONS",
  files: "FILES",
  commands: "COMMANDS",
  topAgent: "Top agent",
  topProject: "Top project",
  busiestDay: "Busiest day",
  longestSession: "Longest session",
  approved: "Approved",
  denied: "Denied",
  footer: "Coucou · github.com/Louis-CFM/coucou",
};

/** Block heights, so the whole stack can be centred like the Mac's VStack. */
const H = {
  /** Mochi's body fills ~60 % of the square the engine draws into. */
  mochi: 220,
  mochiDraw: 320,
  header: 20 + 62 + 6 + 36 + 14 + 29 + 80,
  time: 110 + 6 + 26,
  stats: 56 + 94,
  lines: 24 + 34,
  badgesGap: 56,
  badge: 66,
  badgeGap: 16,
  footerBottom: 60 + 24,
  minTop: 40,
};
const SIDE = 60;
const STATS_SIDE = 40;

type Ctx = CanvasRenderingContext2D;

interface Box {
  left: number;
  top: number;
  w: number;
  h: number;
}

function font(x: Ctx, weight: number, size: number, family = FONT) {
  x.font = `${weight} ${size}px ${family}`;
}

/** Shrinks the font until `text` fits in `maxW`, down to `minScale` (minimumScaleFactor). */
function fitFont(x: Ctx, text: string, fit: { weight: number; size: number; maxW: number; minScale: number }) {
  let s = fit.size;
  font(x, fit.weight, s);
  while (x.measureText(text).width > fit.maxW && s > fit.size * fit.minScale) {
    s -= 2;
    font(x, fit.weight, s);
  }
}

/** Text with letter spacing, centred on `cx`: `letterSpacing` is not everywhere yet. */
function spaced(x: Ctx, text: string, at: { cx: number; y: number }, spacing: number) {
  const chars = [...text];
  const widths = chars.map((c) => x.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let left = at.cx - total / 2;
  x.textAlign = "left";
  chars.forEach((c, i) => {
    x.fillText(c, left, at.y);
    left += widths[i] + spacing;
  });
}

/** Cuts `text` with an ellipsis so it fits `maxW` in the current font. */
function ellipsize(x: Ctx, text: string, maxW: number): string {
  if (x.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && x.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function roundRect(x: Ctx, b: Box, r: number) {
  x.beginPath();
  x.moveTo(b.left + r, b.top);
  x.arcTo(b.left + b.w, b.top, b.left + b.w, b.top + b.h, r);
  x.arcTo(b.left + b.w, b.top + b.h, b.left, b.top + b.h, r);
  x.arcTo(b.left, b.top + b.h, b.left, b.top, r);
  x.arcTo(b.left, b.top, b.left + b.w, b.top, r);
  x.closePath();
}

/** One rounded row: a dim label on the left, its value on the right. */
function badge(x: Ctx, b: Omit<Box, "h">, [label, value]: [string, string]) {
  x.fillStyle = "rgba(255,255,255,0.05)";
  roundRect(x, { ...b, h: H.badge }, 18);
  x.fill();
  const mid = b.top + H.badge / 2;
  x.textBaseline = "middle";
  font(x, 400, 24);
  x.fillStyle = DIM;
  x.textAlign = "left";
  x.fillText(label, b.left + 32, mid);
  const labelW = x.measureText(label).width;
  font(x, 600, 24);
  x.fillStyle = INK;
  x.textAlign = "right";
  x.fillText(ellipsize(x, value, b.w - 64 - labelW - 16), b.left + b.w - 32, mid);
  x.textBaseline = "top";
}

/** A still Mochi, drawn by the same engine as the island's. */
function drawMochi(x: Ctx, cx: number, top: number, size: number) {
  const engine = new BotEngine();
  engine.setState("idle", true);
  engine.update(1 / 60);
  x.save();
  x.translate(cx - size / 2, top);
  engine.draw(x, size, size);
  x.restore();
}

/** Near-black with an indigo glow low in the frame. */
function drawBackground(x: Ctx) {
  const cx = SHARE_W / 2;
  x.fillStyle = "#0B0C0E";
  x.fillRect(0, 0, SHARE_W, SHARE_H);
  const glow = x.createRadialGradient(cx, SHARE_H * 0.75, 0, cx, SHARE_H * 0.75, 900);
  glow.addColorStop(0, "rgba(99,102,241,0.30)");
  glow.addColorStop(0.65, "rgba(99,102,241,0)");
  x.fillStyle = glow;
  x.fillRect(0, 0, SHARE_W, SHARE_H);
}

/** The label / value rows under the stats; project names left out on request. */
function badgeList(s: WeeklySummary, hideProjects: boolean): [string, string][] {
  const badges: [string, string][] = [];
  if (s.topAgent) badges.push([T.topAgent, s.topAgent]);
  if (!hideProjects && s.topProject) badges.push([T.topProject, s.topProject]);
  if (s.busiestDay) badges.push([T.busiestDay, s.busiestDay]);
  if (s.longestSessionMinutes > 1) badges.push([T.longestSession, formatDuration(s.longestSessionMinutes)]);
  return badges;
}

const hasLines = (s: WeeklySummary) => s.linesAdded + s.linesRemoved > 0;
const hasDecisions = (s: WeeklySummary) => s.permissionsAllowed + s.permissionsDenied > 0;

/** Where the stack starts so that it sits centred above the footer. */
function stackTop(s: WeeklySummary, badges: number): number {
  const rows = badges + (hasDecisions(s) ? 1 : 0);
  const badgeBlock = rows > 0 ? H.badgesGap + rows * H.badge + (rows - 1) * H.badgeGap : 0;
  const blockH = H.mochi + H.header + H.time + H.stats + (hasLines(s) ? H.lines : 0) + badgeBlock;
  return Math.max(H.minTop, (SHARE_H - H.footerBottom - blockH) / 2);
}

/** Mochi, "Coucou", the title and the week's dates. */
function drawHeader(x: Ctx, s: WeeklySummary, top: number): number {
  const cx = SHARE_W / 2;
  drawMochi(x, cx, top + H.mochi / 2 - H.mochiDraw / 2 - H.mochiDraw * 0.02, H.mochiDraw);
  let y = top + H.mochi + 20;
  x.fillStyle = INK;
  x.textAlign = "center";
  font(x, 900, 52);
  x.fillText("Coucou", cx, y);
  y += 62 + 6;
  x.fillStyle = DIM;
  font(x, 500, 30);
  x.fillText(T.title, cx, y);
  y += 36 + 14;
  x.fillStyle = INDIGO_TEXT;
  font(x, 400, 24);
  x.fillText(weekRangeLabel(s), cx, y);
  return y + 29 + 80;
}

/** Time spent: the headline number. */
function drawTime(x: Ctx, s: WeeklySummary, top: number): number {
  const cx = SHARE_W / 2;
  const time = formatDuration(s.totalMinutes);
  x.fillStyle = INK;
  fitFont(x, time, { weight: 900, size: 100, maxW: SHARE_W - 120, minScale: 0.4 });
  x.textAlign = "center";
  x.fillText(time, cx, top);
  x.fillStyle = DIM;
  font(x, 600, 22);
  spaced(x, T.timeCoding, { cx, y: top + 110 + 6 }, 3);
  return top + H.time + 56;
}

/** Sessions | files | commands, in columns with a hairline between them. */
function drawStats(x: Ctx, s: WeeklySummary, top: number): number {
  const stats: [string, string][] = [
    [formatCount(s.sessionCount), T.sessions],
    [formatCount(s.filesChanged), T.files],
  ];
  if (s.commandsRun > 0) stats.push([formatCount(s.commandsRun), T.commands]);
  const colW = (SHARE_W - STATS_SIDE * 2) / stats.length;
  stats.forEach(([value, label], i) => {
    const colCx = STATS_SIDE + colW * (i + 0.5);
    if (i > 0) {
      x.fillStyle = "rgba(255,255,255,0.08)";
      x.fillRect(STATS_SIDE + colW * i, top + 7, 1, 80);
    }
    x.fillStyle = INK;
    fitFont(x, value, { weight: 900, size: 64, maxW: colW - 24, minScale: 0.5 });
    x.textAlign = "center";
    x.fillText(value, colCx, top);
    x.fillStyle = DIM;
    font(x, 600, 18);
    spaced(x, label, { cx: colCx, y: top + 72 }, 2);
  });
  return top + 94;
}

/** "+120 −34", centred, when lines changed. */
function drawLines(x: Ctx, s: WeeklySummary, top: number): number {
  if (!hasLines(s)) return top;
  const y = top + 24;
  const plus = `+${formatCount(s.linesAdded)}`;
  const minus = `−${formatCount(s.linesRemoved)}`;
  font(x, 600, 28, MONO);
  const pw = x.measureText(plus).width;
  const mw = x.measureText(minus).width;
  const start = SHARE_W / 2 - (pw + 24 + mw) / 2;
  x.textAlign = "left";
  x.fillStyle = PLUS;
  x.fillText(plus, start, y);
  x.fillStyle = MINUS;
  x.fillText(minus, start + pw + 24, y);
  return y + 34;
}

function drawBadges(x: Ctx, s: WeeklySummary, badges: [string, string][], top: number) {
  if (badges.length === 0 && !hasDecisions(s)) return;
  let y = top + H.badgesGap;
  const w = SHARE_W - SIDE * 2;
  for (const row of badges) {
    badge(x, { left: SIDE, top: y, w }, row);
    y += H.badge + H.badgeGap;
  }
  if (!hasDecisions(s)) return;
  const half = (w - H.badgeGap) / 2;
  badge(x, { left: SIDE, top: y, w: half }, [T.approved, formatCount(s.permissionsAllowed)]);
  badge(x, { left: SIDE + half + H.badgeGap, top: y, w: half }, [T.denied, formatCount(s.permissionsDenied)]);
}

function drawFooter(x: Ctx) {
  x.textBaseline = "top";
  x.textAlign = "center";
  x.fillStyle = "rgba(142,147,156,0.6)";
  font(x, 500, 20, MONO);
  x.fillText(T.footer, SHARE_W / 2, SHARE_H - H.footerBottom);
}

export function renderShareImage(s: WeeklySummary, hideProjects: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SHARE_W;
  canvas.height = SHARE_H;
  const x = canvas.getContext("2d");
  if (!x) return canvas;
  drawBackground(x);
  const badges = badgeList(s, hideProjects);
  x.textBaseline = "top";
  let y = drawHeader(x, s, stackTop(s, badges.length));
  y = drawTime(x, s, y);
  y = drawStats(x, s, y);
  y = drawLines(x, s, y);
  drawBadges(x, s, badges, y);
  drawFooter(x);
  return canvas;
}

/** The canvas as a PNG data URL, for Rust to write to disk. */
export function toPngDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png");
}

/** The canvas as a PNG blob, for the clipboard. */
export function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
