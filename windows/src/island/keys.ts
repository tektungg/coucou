// The island's own keys, while it has the keyboard: Escape closes it, ← → page
// through the pills like a swipe (views/carousel.ts). Split out of island.ts.

import { State } from "../core/state";
import { stepFocus } from "../views/carousel";

export interface KeysHost {
  collapse(): void;
}

export function wireKeys(host: KeysHost) {
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) host.collapse();
    const paging = e.key === "ArrowLeft" || e.key === "ArrowRight";
    if (paging && State.mode === "expanded" && State.view === "overview") {
      const ids = State.visibleTasks.map((t) => t.id);
      const next = stepFocus(ids, State.focusTask?.id ?? null, e.key === "ArrowRight" ? 1 : -1);
      if (next) State.setFocus(next);
    }
    State.lastActivity = performance.now();
  });
}
