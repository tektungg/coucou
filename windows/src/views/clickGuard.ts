// A decision card (permission, plan, question) pops up under a cursor that was
// busy with the window underneath: a click meant for that window must not land
// on Allow or "Yes, bypass". Clicks in the first moments after a new request
// shows are ignored. Ported from upstream (Louis-CFM/coucou 5b06e1c) and
// extended to the plan and question cards.

/** How long a fresh decision card ignores clicks on its buttons. */
export const CLICK_GUARD_MS = 600;

export interface ClickGuard {
  /** Call on every render with what is on screen; the clock restarts only when it changes. */
  arm(key: string | null): void;
  /** False while the card is still too fresh to take a click. */
  allows(): boolean;
  /** `action`, made to do nothing while the card is too fresh. */
  wrap<A extends unknown[]>(action: (...args: A) => void): (...args: A) => void;
}

export function createClickGuard(now: () => number = () => performance.now(), windowMs = CLICK_GUARD_MS): ClickGuard {
  let shownFor: string | null = null;
  let shownAt = Number.NEGATIVE_INFINITY;
  const allows = () => now() - shownAt >= windowMs;
  return {
    arm(key) {
      if (key === shownFor) return;
      shownFor = key;
      shownAt = now();
    },
    allows,
    wrap(action) {
      return (...args) => {
        if (allows()) action(...args);
      };
    },
  };
}
