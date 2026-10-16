// Home's session board, as DOM (Mochi Pop): Mochi's speech bubble on top, a row
// of pastel tiles below. What it says is worked out in board.ts; this file only
// draws it and rebuilds when that changes.

import { h, clear, face } from "./dom";
import { sessionBoard, type Board, type BoardMark, type BoardSession, type BoardTile } from "./board";
import { diffCounts } from "./diff";

/** A tile's +N −M was clicked: open that session's diff. */
export type OpenDiff = (pillId: string, diffId: number) => void;

const TILE_FACE = 22;
/** Faces stay white on the pastel tiles, as in the mockup. */
const TILE_FACE_COLOR = "#ffffff";
const MARK_TEXT: Record<BoardMark, string> = { done: "✓", ask: "!", error: "×" };

/** The tile's +N −M; a click opens the diff instead of focusing the tile. */
function diffChip(tile: BoardTile, openDiff: OpenDiff): HTMLElement | null {
  const diff = tile.diff;
  if (!diff || (diff.added === 0 && diff.removed === 0)) return null;
  const chip = diffCounts(diff.added, diff.removed);
  chip.classList.add("btile-diff");
  chip.title = "Show the changes";
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    openDiff(tile.id, diff.diffId);
  });
  return chip;
}

function tileEl(tile: BoardTile, focus: (id: string) => void, openDiff: OpenDiff): HTMLElement {
  const el = h("button", {
    class: tile.active ? "btile on" : "btile",
    title: tile.usage ? `${tile.name} · ${tile.usage}` : tile.name,
    onclick: () => focus(tile.id),
  },
  face(TILE_FACE_COLOR, TILE_FACE),
  h("div", { class: "btile-text" },
    h("div", { class: "btile-top" }, h("b", { text: tile.name }), tile.usage ? h("small", { text: tile.usage }) : null),
    h("div", { class: "btile-line" }, h("span", { text: tile.line }), diffChip(tile, openDiff))),
  tile.mark ? h("i", { class: `btile-mark ${tile.mark}`, text: MARK_TEXT[tile.mark] }) : null);
  el.style.setProperty("--tc", tile.color);
  return el;
}

function moreEl(more: NonNullable<Board["more"]>, focus: (id: string) => void): HTMLElement {
  return h("button", { class: "btile more", onclick: () => focus(more.nextId) }, h("b", { text: `+${more.count} more` }));
}

/** The board, rebuilt only when what it shows changes. */
export function buildBoardView(focus: (id: string) => void, openDiff: OpenDiff) {
  const bubble = h("div", { class: "board-bubble" });
  const tiles = h("div", { class: "board-tiles" });
  const el = h("div", { class: "board" }, bubble, tiles);
  let key = "";
  return {
    el,
    sync(sessions: BoardSession[], focusId: string, nowMs: number) {
      const board = sessionBoard(sessions, focusId, nowMs);
      const next = JSON.stringify(board);
      if (next === key) return;
      key = next;
      bubble.textContent = board.bubble;
      clear(tiles);
      tiles.append(...board.tiles.map((t) => tileEl(t, focus, openDiff)));
      if (board.more) tiles.append(moreEl(board.more, focus));
    },
  };
}
