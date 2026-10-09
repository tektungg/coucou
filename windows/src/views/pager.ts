// The header's pill chips (Mochi Pop): one chip per pill, a mini Mochi in the
// pill's colour. The active chip also shows the pill's name; when the strip runs
// out of room, the pills furthest from the active one fold into a "+N" chip.
// Pure layout, so it is tested in tests/pager.test.ts.

import type { PillBadge } from "../core/state";

export interface PagerPill {
  id: string;
  name: string;
  badge?: PillBadge | null;
}

export interface PagerChip {
  id: string;
  /** Shown only on the active chip. */
  label: string | null;
  badge: PillBadge | null;
}

export interface PagerLayout {
  chips: PagerChip[];
  /** Pills that did not fit, and the one the "+N" chip opens (the next after the active one). */
  overflow: { count: number; nextId: string } | null;
}

/**
 * Room the strip has between the tabs and the header buttons in the 640 px
 * header: about 370 px with the mic button showing, less a margin.
 */
export const PAGER_MAX_W = 340;
/** A chip with only its face, and the gap between chips (style.css .pchip). */
export const CHIP_W = 24;
export const CHIP_GAP = 4;
/** The active chip's name: estimated width per character, and its cap (CSS max-width). */
const LABEL_CHAR_W = 6.5;
export const LABEL_MAX_W = 100;
const LABEL_PAD = 8;

/** The name a pill shows in the header. */
export const pillLabel = (p: PagerPill) => (p.id === "integration_claude" ? "VS Code" : p.name);

export function labelWidth(label: string): number {
  return Math.min(LABEL_MAX_W, label.length * LABEL_CHAR_W) + LABEL_PAD;
}

/** Indices kept around the active pill, growing outward until `fits` says no. */
function keptAround(count: number, active: number, fits: (kept: number) => boolean): Set<number> {
  const kept = new Set([active]);
  for (let step = 1; kept.size < count; step++) {
    for (const i of [active + step, active - step]) {
      if (i < 0 || i >= count || kept.has(i)) continue;
      if (!fits(kept.size + 1)) return kept;
      kept.add(i);
    }
  }
  return kept;
}

export function pagerChips(pills: PagerPill[], focusId: string, maxWidth = PAGER_MAX_W): PagerLayout {
  if (pills.length === 0) return { chips: [], overflow: null };
  const found = pills.findIndex((p) => p.id === focusId);
  const active = found < 0 ? 0 : found;
  const activeExtra = labelWidth(pillLabel(pills[active]));
  const width = (chips: number) => chips * CHIP_W + (chips - 1) * CHIP_GAP + activeExtra;
  // With an overflow chip the strip holds one chip more than the pills it shows.
  const fitsAll = width(pills.length) <= maxWidth;
  const kept = fitsAll
    ? new Set(pills.map((_, i) => i))
    : keptAround(pills.length, active, (n) => width(n + 1) <= maxWidth);

  const chips = pills
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => kept.has(i))
    .map(({ p, i }) => ({ id: p.id, label: i === active ? pillLabel(p) : null, badge: p.badge ?? null }));
  if (fitsAll) return { chips, overflow: null };

  const hidden = pills.length - kept.size;
  const next = pills.find((_, i) => i > active && !kept.has(i)) ?? pills.find((_, i) => !kept.has(i));
  return { chips, overflow: next ? { count: hidden, nextId: next.id } : null };
}
