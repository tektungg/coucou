// What the collapsed island shows next to Mochi: the other pills as mini
// Mochis, the mic badge, or the line being sung while the Music pill plays.
// Split out of island.ts.

import { State } from "../core/state";
import { createMiniBot, pruneMiniBots, syncMiniBotStates } from "../mochi/minibots";
import { h, svg } from "../views/dom";
import { lyricStripActive, lyricStripEl } from "../views/personal";
import { MIC_ICON, MIC_OFF_ICON } from "../views/shelf";
import { headerMicBadge } from "../views/views";

/** Mini Mochis shown at most. */
const MINI_BOTS_MAX = 4;
const MINI_BOT_PX = 13;
/** Room the compact Mochi (cx 40, 20 px wide) takes on each side of the lyric line. */
const LYRIC_SIDE_PX = 58;
/** The mini grid's distance from the right edge, and the room the mic badge adds. */
const GRID_RIGHT_PX = 40 + 14.5;
const BADGE_ROOM_PX = 24;
const BADGE_RIGHT_PX = 32;
const GRID_HALF_H = 14.5;
const BADGE_HALF_H = 9;
const BADGE_ICON_PX = 11;

/** Collapsed on a playing Music pill: the island sings instead of showing the other pills. */
export function lyricMode(): boolean {
  return State.mode === "compact" && lyricStripActive();
}

export class CompactBar {
  readonly miniGrid = h("div", { id: "mini-grid" });
  /** Collapsed island: an app is recording (red) into the mic, or into a muted one (grey). */
  readonly micBadge = h("div", { id: "mic-badge" });
  private badgeShown: "live" | "muted" | null = null;
  private lastLyricMode = false;

  /** Places the bar's parts on an island `w` × `hh`; follows it as it resizes. */
  layout(w: number, hh: number) {
    this.miniGrid.style.left = `${this.gridLeft(w)}px`;
    this.miniGrid.style.top = `${hh / 2 - GRID_HALF_H}px`;
    this.micBadge.style.left = `${w - BADGE_RIGHT_PX}px`;
    this.micBadge.style.top = `${hh / 2 - BADGE_HALF_H}px`;
    // Clear of the compact Mochi on both sides, so the line is centred on the island.
    const strip = lyricStripEl();
    strip.style.width = `${Math.max(0, w - 2 * LYRIC_SIDE_PX)}px`;
    strip.style.height = `${hh}px`;
  }

  /** Syncs with State. True when lyric mode just flipped: the island resizes. */
  sync(w: number): boolean {
    const lyric = lyricMode();
    const flipped = lyric !== this.lastLyricMode;
    this.lastLyricMode = lyric;
    lyricStripEl().style.opacity = lyric ? "1" : "0";
    this.syncBadge(w);
    this.syncGrid(State.mode === "compact" && !lyric);
    syncMiniBotStates(State.tasks);
    return flipped;
  }

  private gridLeft(w: number): number {
    return w - GRID_RIGHT_PX - (this.badgeShown ? BADGE_ROOM_PX : 0);
  }

  private syncBadge(w: number) {
    const badge = State.mode === "compact" ? headerMicBadge() : null;
    if (badge === this.badgeShown) return;
    this.badgeShown = badge;
    this.micBadge.replaceChildren(svg(badge === "muted" ? MIC_OFF_ICON : MIC_ICON, BADGE_ICON_PX, { stroke: 2.2 }));
    this.micBadge.classList.toggle("muted", badge === "muted");
    this.micBadge.style.opacity = badge ? "1" : "0";
    // The mini bots make room for it.
    this.miniGrid.style.left = `${this.gridLeft(w)}px`;
  }

  private syncGrid(show: boolean) {
    this.miniGrid.style.opacity = show ? "1" : "0";
    if (!show) return;
    const others = State.otherTasks.slice(0, MINI_BOTS_MAX);
    const key = others.map((t) => t.id).join("|");
    if (this.miniGrid.dataset.key === key) return;
    this.miniGrid.dataset.key = key;
    this.miniGrid.replaceChildren();
    for (const t of others) this.miniGrid.append(createMiniBot(t, MINI_BOT_PX));
    pruneMiniBots();
  }
}
