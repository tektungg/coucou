// Home's session board, as DOM (Mochi Pop): Mochi's speech bubble on top, a row
// of pastel tiles below. What it says is worked out in board.ts; this file only
// draws it and rebuilds when that changes.

import { h, clear, face } from "./dom";
import { sessionBoard, type Board, type BoardMark, type BoardSession, type BoardTile } from "./board";

const TILE_FACE = 22;
/** Faces stay white on the pastel tiles, as in the mockup. */
const TILE_FACE_COLOR = "#ffffff";
const MARK_TEXT: Record<BoardMark, string> = { done: "✓", ask: "!", error: "×" };

function tileEl(tile: BoardTile, focus: (id: string) => void): HTMLElement {
  const el = h("button", {
    class: tile.active ? "btile on" : "btile",
    title: tile.usage ? `${tile.name} · ${tile.usage}` : tile.name,
    onclick: () => focus(tile.id),
  },
  face(TILE_FACE_COLOR, TILE_FACE),
  h("div", { class: "btile-text" },
    h("div", { class: "btile-top" }, h("b", { text: tile.name }), tile.usage ? h("small", { text: tile.usage }) : null),
    h("span", { text: tile.line })),
  tile.mark ? h("i", { class: `btile-mark ${tile.mark}`, text: MARK_TEXT[tile.mark] }) : null);
  el.style.setProperty("--tc", tile.color);
  return el;
}

function moreEl(more: NonNullable<Board["more"]>, focus: (id: string) => void): HTMLElement {
  return h("button", { class: "btile more", onclick: () => focus(more.nextId) }, h("b", { text: `+${more.count} more` }));
}

/** The board, rebuilt only when what it shows changes. */
export function buildBoardView(focus: (id: string) => void) {
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
      tiles.append(...board.tiles.map((t) => tileEl(t, focus)));
      if (board.more) tiles.append(moreEl(board.more, focus));
    },
  };
}
