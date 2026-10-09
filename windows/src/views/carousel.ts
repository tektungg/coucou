// Overview carousel: one pill on screen, swipe (trackpad, drag, arrows) or
// tap a chip to move. No DOM here: the stepping and gesture rules, tested alone.
//
// Claude Code sessions are one stop: a single "Claude Code" chip in the header,
// and Home's board shows the sessions inside it (views/board.ts). Stepping
// moves past all of them at once; a tile on the board picks one.

/**
 * island/sessions.ts SESSION_PREFIX. Copied, not imported, so node --test can
 * load this file; tests/carousel.test.ts checks the two never drift apart.
 */
export const SESSION_STOP_PREFIX = "cc_";

const isSessionStop = (id: string) => id.startsWith(SESSION_STOP_PREFIX);

/** The run of session pills collapses to one stop: `current` if it is one of them, else the first. */
export function pillStops(ids: string[], current: string | null): string[] {
  const stops: string[] = [];
  let inRun = false;
  for (const id of ids) {
    const session = isSessionStop(id);
    if (session && inRun) {
      if (id === current) stops[stops.length - 1] = id;
      continue;
    }
    inRun = session;
    stops.push(id);
  }
  return stops;
}

/** The pill next to `current`, wrapping round at either end. */
export function stepFocus(ids: string[], current: string | null, dir: 1 | -1): string | null {
  const stops = pillStops(ids, current);
  if (stops.length === 0) return null;
  const at = current == null ? -1 : stops.indexOf(current);
  if (at < 0) return stops[0];
  return stops[(at + dir + stops.length) % stops.length];
}

/** -1 = moved to an earlier pill, 1 = a later one, 0 = same, unknown or within the sessions. */
export function slideDirection(ids: string[], from: string | null, to: string | null): -1 | 0 | 1 {
  if (from == null || to == null || from === to) return 0;
  const key = (id: string) => (isSessionStop(id) ? SESSION_STOP_PREFIX : id);
  const keys = pillStops(ids, null).map(key);
  const a = keys.indexOf(key(from));
  const b = keys.indexOf(key(to));
  if (a < 0 || b < 0 || a === b) return 0;
  return b > a ? 1 : -1;
}

/** A pill as the header's chips see it. */
export interface StopPill {
  id: string;
  name: string;
  color: string;
  badge?: "approval" | "finished" | "error" | null;
}

/** The header chip standing for every session; a UI id, never stored anywhere. */
export const SESSIONS_CHIP_ID = "claude-code-sessions";

/** The most urgent badge first: a request waiting on you, an error, news. */
const BADGE_RANK: Record<string, number> = { approval: 0, error: 1, finished: 2 };

/**
 * The header's pills, with every session folded into one "Claude Code" chip.
 * `targetId` is what a click focuses: for the sessions chip, the focused
 * session if one is, else one that waits on you, else the most recent.
 */
export function sessionChips(pills: StopPill[], focusId: string, group: { name: string; color: string }):
  { pills: (StopPill & { targetId: string })[]; focusChip: string } {
  const sessions = pills.filter((p) => isSessionStop(p.id));
  const plain = (p: StopPill) => ({ ...p, targetId: p.id });
  if (sessions.length === 0) return { pills: pills.map(plain), focusChip: focusId };
  const target = sessions.find((s) => s.id === focusId) ?? sessions.find((s) => s.badge === "approval") ?? sessions[0];
  const badge = sessions.map((s) => s.badge).filter((b) => b != null)
    .sort((x, y) => BADGE_RANK[x] - BADGE_RANK[y])[0] ?? null;
  const chip = {
    id: SESSIONS_CHIP_ID, name: sessions.length > 1 ? `${group.name} · ${sessions.length}` : group.name,
    color: group.color, badge, targetId: target.id,
  };
  const first = pills.findIndex((p) => isSessionStop(p.id));
  const rest = pills.filter((p) => !isSessionStop(p.id)).map(plain);
  rest.splice(first, 0, chip);
  return { pills: rest, focusChip: isSessionStop(focusId) ? SESSIONS_CHIP_ID : focusId };
}

/** Horizontal travel, in pixels, that counts as one swipe. */
export const SWIPE_DISTANCE = 60;
/** A pause longer than this starts a new gesture. */
export const GESTURE_GAP_MS = 250;
/** After a swipe, the rest of the same flick is ignored for this long. */
export const SWIPE_COOLDOWN_MS = 450;

/**
 * Turns trackpad / tilt-wheel `deltaX` events into whole swipes. A precision
 * trackpad sends a stream of small deltas plus momentum: they are summed, one
 * swipe fires at SWIPE_DISTANCE, and the momentum tail is swallowed.
 */
export class SwipeAccumulator {
  private sum = 0;
  private lastAt = -Infinity;
  private quietUntil = -Infinity;

  /** Returns 1 (next), -1 (previous) or 0. Mostly-vertical scrolls never count. */
  add(deltaX: number, deltaY: number, nowMs: number): -1 | 0 | 1 {
    if (Math.abs(deltaX) <= Math.abs(deltaY)) return 0;
    if (nowMs - this.lastAt > GESTURE_GAP_MS) this.sum = 0;
    this.lastAt = nowMs;
    if (nowMs < this.quietUntil) return 0;
    this.sum += deltaX;
    if (Math.abs(this.sum) < SWIPE_DISTANCE) return 0;
    const dir = this.sum > 0 ? 1 : -1;
    this.sum = 0;
    this.quietUntil = nowMs + SWIPE_COOLDOWN_MS;
    return dir;
  }
}

/** Minimum horizontal drag, in pixels, for a mouse swipe. */
export const DRAG_DISTANCE = 40;

/**
 * A mouse drag released after moving (dx, dy): dragging left shows the next
 * pill, like pushing the card away; mostly-vertical or short drags are clicks.
 */
export function dragDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < DRAG_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}
