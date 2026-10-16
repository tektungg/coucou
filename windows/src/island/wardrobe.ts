// The wardrobe from the island: a right-click on Mochi opens it, and closes it
// again; over Mochi the browser's own menu never shows. Ported from upstream
// (Louis-CFM/coucou c97dec1), where it lived in island.ts.

import type { IslandViewName } from "../core/layout";
import { State } from "../core/state";

/** Pointer button for a right-click. */
const RIGHT_BUTTON = 2;

export interface WardrobeHost {
  /** The drop sequence owns the island body (it draws a Mochi of its own). */
  readonly uploadActive: boolean;
  isBotHit(x: number, y: number): boolean;
  setView(view: IslandViewName): void;
  /** A press on Mochi ends the hearts' hover. */
  cancelBotHover(): void;
}

/** Wardrobe open ↔ back to the usual view. Not over the greeting or a drop. */
export function toggleWardrobe(host: WardrobeHost) {
  if (State.paused || State.mode === "hidden") return;
  if (State.mode === "expanded" && (State.view === "greeting" || host.uploadActive)) return;
  if (State.mode === "expanded" && State.view === "wardrobe") host.setView(State.defaultView());
  else host.setView("wardrobe");
}

/** A right-click on Mochi toggles the wardrobe; true when it did (nothing else runs). */
export function rightClickedMochi(host: WardrobeHost, e: MouseEvent): boolean {
  if (e.button !== RIGHT_BUTTON || !host.isBotHit(e.clientX, e.clientY)) return false;
  host.cancelBotHover();
  toggleWardrobe(host);
  return true;
}

/** No browser menu over Mochi: his right-click is the wardrobe. Elsewhere (the chat) it stays. */
export function blockMenuOverMochi(el: HTMLElement, host: WardrobeHost) {
  el.addEventListener("contextmenu", (e) => {
    if (host.isBotHit(e.clientX, e.clientY)) e.preventDefault();
  });
}

/** A try-on never outlives the wardrobe. */
export function dropPreviewOutsideWardrobe() {
  if (State.wardrobePreview && !(State.mode === "expanded" && State.view === "wardrobe")) State.wardrobePreview = null;
}
