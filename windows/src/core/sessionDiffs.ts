// The live diffs of each pill (core/diff.ts), kept so a board tile's +N −M can
// open the diff card. Same caps as macOS: 50 per pill, forgotten an hour after
// the last one. Ported from upstream (Louis-CFM/coucou 122e130), where it lived
// in AppState.

import type { FileDiff } from "./diff";

/** Live diffs kept per pill (oldest dropped first). */
export const MAX_DIFFS_PER_PILL = 50;
/** A pill's diffs are forgotten after an hour without a new one. */
export const DIFF_TTL_MS = 3_600_000;

export class SessionDiffs {
  private byPill = new Map<string, FileDiff[]>();
  private timers = new Map<string, number>();
  /** Never reset, so an id can never point at a newer diff than the one tapped. */
  private nextId = 0;

  /** Stores a diff for a pill and returns its id (for the diff step). */
  append(pillId: string, diff: FileDiff): number {
    const id = this.nextId++;
    const list = this.byPill.get(pillId) ?? [];
    list.push({ ...diff, id });
    while (list.length > MAX_DIFFS_PER_PILL) list.shift();
    this.byPill.set(pillId, list);
    // One timer per pill, re-armed on every diff: nothing polls.
    const prev = this.timers.get(pillId);
    if (prev != null) window.clearTimeout(prev);
    this.timers.set(pillId, window.setTimeout(() => this.clear(pillId), DIFF_TTL_MS));
    return id;
  }

  find(pillId: string, id: number): FileDiff | null {
    return this.byPill.get(pillId)?.find((d) => d.id === id) ?? null;
  }

  count(pillId: string): number {
    return this.byPill.get(pillId)?.length ?? 0;
  }

  clear(pillId: string) {
    const timer = this.timers.get(pillId);
    if (timer != null) window.clearTimeout(timer);
    this.timers.delete(pillId);
    this.byPill.delete(pillId);
  }
}

export const sessionDiffs = new SessionDiffs();
