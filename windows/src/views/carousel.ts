// Overview carousel: one pill on screen, swipe (trackpad, drag, arrows) or
// tap a dot to move. No DOM here: the stepping and gesture rules, tested alone.

/** The pill next to `current`, wrapping round at either end. */
export function stepFocus(ids: string[], current: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current == null ? -1 : ids.indexOf(current);
  if (at < 0) return ids[0];
  return ids[(at + dir + ids.length) % ids.length];
}

/** -1 = moved to an earlier pill, 1 = a later one, 0 = same or unknown. */
export function slideDirection(ids: string[], from: string | null, to: string | null): -1 | 0 | 1 {
  if (from == null || to == null || from === to) return 0;
  const a = ids.indexOf(from);
  const b = ids.indexOf(to);
  if (a < 0 || b < 0) return 0;
  return b > a ? 1 : -1;
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
