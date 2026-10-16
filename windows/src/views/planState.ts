// Plan usage in the island, without the DOM: which header pills show, which
// card is open, the Codex numbers and when Codex is asked for them. The pills
// and the card are drawn by views/plan.ts; the numbers and labels come from
// core/plan.ts. Ported from upstream views/usage.ts (Louis-CFM/coucou c02923e).
//
// Both pills are off by default (Settings > General), on the overview only.
// Clicking one opens its card in place of Home's card; it closes when the view,
// the mode or the focused pill changes, or when its pill is clicked again.

import { Bridge } from "../core/bridge";
import {
  codexShouldAsk, dominantPct, parseCodexPlan, planColor, planFromQuota,
  type CodexPlanUsage, type PlanUsage,
} from "../core/plan";
import { State } from "../core/state";

export type PlanKind = "claude" | "codex";

const QUOTA_PILL = "integration_quota";

/** The Claude pill is in the header: overview, turned on. */
export function claudePillVisible(): boolean {
  return State.view === "overview" && State.settings.showPlanInNotch === true;
}

/** The Codex pill is in the header: overview, turned on (nothing to install). */
export function codexPillVisible(): boolean {
  return State.view === "overview" && State.settings.showCodexPlanInNotch === true;
}

const pillVisible = (kind: PlanKind) => (kind === "codex" ? codexPillVisible() : claudePillVisible());

/** How many plan pills the header shows (the pager gives up their room). */
export function visiblePlanPills(): number {
  return Number(claudePillVisible()) + Number(codexPillVisible());
}

/** Claude's numbers: the Claude pill's own snapshot, polled whether or not that pill is on. */
export function claudePlanUsage(now = Date.now()): PlanUsage | null {
  return planFromQuota(State.integrations[QUOTA_PILL]?.data, now);
}

// ── Codex numbers ─────────────────────────────────────────────────────────────

let codexUsage: CodexPlanUsage | null = null;
let codexInFlight = false;
let codexAskedAt: number | null = null;

export const codexPlanUsage = (): CodexPlanUsage | null => codexUsage;
export const codexAsking = (): boolean => codexInFlight;

/** New Codex numbers (from `codex app-server`, or the dev harness). */
export function setCodexPlanUsage(usage: CodexPlanUsage | null): void {
  codexUsage = usage;
  State.notify();
}

/**
 * Asks Codex again when there is no answer and no attempt from the last
 * minute. Only from the pill (shown or clicked), never on a timer, and never
 * while paused: `codex app-server` talks to Codex's own service.
 */
export function refreshCodexPlanUsage(now = Date.now()): void {
  if (codexInFlight || State.paused || !codexShouldAsk(codexUsage, codexAskedAt, now)) return;
  codexInFlight = true;
  codexAskedAt = now;
  State.notify();
  void Bridge.codexPlanUsage()
    .then((result) => {
      const usage = parseCodexPlan(result);
      if (usage) codexUsage = usage;
    })
    .finally(() => {
      codexInFlight = false;
      State.notify();
    });
}

/** Forgets the Codex numbers and the last attempt (tests). */
export function resetCodexPlanUsage(): void {
  codexUsage = null;
  codexInFlight = false;
  codexAskedAt = null;
}

// ── The open card ─────────────────────────────────────────────────────────────

/** The open card, and the pill that was focused when it opened. */
let open: { kind: PlanKind; focus: string | null } | null = null;

const focusId = () => State.focusTask?.id ?? null;

/** The card still belongs on screen: open island, overview, same focus, its pill still there. */
function stillOpen(o: NonNullable<typeof open>): boolean {
  return State.mode === "expanded" && pillVisible(o.kind) && focusId() === o.focus;
}

/** Which card is open, if any; closes it first when its moment has passed. */
export function openPlanKind(): PlanKind | null {
  if (open && !stillOpen(open)) open = null;
  return open?.kind ?? null;
}

export const planCardOpen = (): boolean => openPlanKind() != null;

/** A pill's click: opens its card, closes it when it is the open one, or swaps cards. */
export function togglePlanCard(kind: PlanKind): void {
  open = openPlanKind() === kind ? null : { kind, focus: focusId() };
  if (kind === "codex") refreshCodexPlanUsage();
  State.notify();
}

export function closePlanCard(): void {
  open = null;
}

/** A plan's colour, from its higher window: what its pill's dot and its card show. */
export function planColorFor(kind: PlanKind, now = Date.now()): string {
  const usage = kind === "codex" ? codexUsage : claudePlanUsage(now);
  return planColor(dominantPct(usage, now));
}

/** The colour Mochi wears while a plan card is open (island/botPainter.ts); null otherwise. */
export function planCardColor(): string | null {
  const kind = openPlanKind();
  return kind ? planColorFor(kind) : null;
}

// Collapsing the island, leaving Home or focusing another pill closes the card
// at once, so it is not there again the next time the island opens.
State.subscribe(() => {
  if (open && !stillOpen(open)) open = null;
});
