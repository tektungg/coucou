// Plan usage in the island (Mochi Pop): the "Claude 73%" / "Codex 12%" pills in
// the header and the card a pill opens in Home. DOM ports of upstream's
// views/usage.ts (Louis-CFM/coucou c02923e), itself ClaudePlanHeaderPill,
// ClaudePlanCardView and CodexPlanCardView on the Mac. The state lives in
// views/planState.ts, the numbers and labels in core/plan.ts.

import {
  PLAN_TEXT, claudeSubtitle, codexResetsLabel, codexSubtitle, effectivePct, longWindowLabel, longWindowSpan,
  pillLabel, planColor, resetLabel, type PlanSpan, type PlanUsage, type PlanWindow,
} from "../core/plan";
import { State } from "../core/state";
import { dot, h, svg } from "./dom";
import { ICONS } from "./icons";
import {
  claudePillVisible, claudePlanUsage, closePlanCard, codexAsking, codexPillVisible, codexPlanUsage, openPlanKind,
  planColorFor, refreshCodexPlanUsage, togglePlanCard, type PlanKind,
} from "./planState";

/** The card's countdowns move on this beat (and its key with them). */
export const PLAN_CLOCK_MS = 30_000;
const DOT_HEAD = 7;
const ICON_BACK = 10;
const ICON_RESET = 9;

const usageOf = (kind: PlanKind, now: number): PlanUsage | null =>
  kind === "codex" ? codexPlanUsage() : claudePlanUsage(now);

// ── Header pills ──────────────────────────────────────────────────────────────

interface PlanPill {
  el: HTMLElement;
  sync(): void;
}

/** One pill: its plan's colour dot and "Claude 73%", white while its card is open. */
function buildPill(kind: PlanKind): PlanPill {
  const mark = h("i", { class: "plan-dot" });
  const label = h("span", { class: "plan-pill-label" });
  const el = h("button", {
    class: "hbtn plan-pill",
    title: kind === "codex" ? PLAN_TEXT.codexPillTitle : PLAN_TEXT.claudePillTitle,
    onclick: () => togglePlanCard(kind),
  }, mark, label);
  const visible = kind === "codex" ? codexPillVisible : claudePillVisible;
  return {
    el,
    sync() {
      const on = visible();
      el.style.display = on ? "" : "none";
      if (!on) return;
      const now = Date.now();
      const text = pillLabel(kind === "codex" ? "Codex" : "Claude", usageOf(kind, now), now);
      if (label.textContent !== text) label.textContent = text;
      mark.style.background = planColorFor(kind, now);
      el.classList.toggle("on", openPlanKind() === kind);
    },
  };
}

/** Both pills, Claude first; hidden (no room taken) while their setting is off. */
export function buildPlanPills(): { els: HTMLElement[]; sync(): void } {
  const pills = [buildPill("claude"), buildPill("codex")];
  let codexShown = false;
  return {
    els: pills.map((p) => p.el),
    sync() {
      for (const p of pills) p.sync();
      // Codex is asked when its pill comes into view (stale numbers only).
      const shown = codexPillVisible() && State.mode === "expanded";
      if (shown && !codexShown) refreshCodexPlanUsage();
      codexShown = shown;
    },
  };
}

// ── Card ──────────────────────────────────────────────────────────────────────

/** What the open card is drawn from: a change (or the next 30 s beat) redraws it. */
export function planCardKey(kind: PlanKind, now = Date.now()): string {
  return [kind, JSON.stringify(usageOf(kind, now)), codexAsking(), Math.floor(now / PLAN_CLOCK_MS)].join("|");
}

function gaugeRow(label: string, w: PlanWindow | undefined, span: PlanSpan, now: number): HTMLElement {
  const row = h("div", { class: "plan-row" }, h("span", { class: "plan-label", text: label }));
  if (!w) {
    row.append(h("span", { class: "plan-none", text: PLAN_TEXT.none }));
    return row;
  }
  const pct = effectivePct(w, now);
  const fill = h("i");
  fill.style.width = `${pct}%`;
  fill.style.background = planColor(pct);
  row.append(
    h("span", { class: "gauge" }, fill),
    h("span", { class: "plan-pct", text: `${Math.round(pct)}%` }),
    h("span", { class: "plan-reset" }, svg(ICONS.arrowClockwise, ICON_RESET, { stroke: 2.6 }),
      h("span", { text: resetLabel(w, span, now) })),
  );
  return row;
}

function cardHead(kind: PlanKind, subtitle: string, now: number, extra: HTMLElement | null): HTMLElement {
  const back = h("button", {
    class: "plan-back",
    title: PLAN_TEXT.back,
    onclick: () => {
      closePlanCard();
      State.notify();
    },
  }, svg(ICONS.chevronLeft, ICON_BACK, { stroke: 2.4 }), dot(planColorFor(kind, now), DOT_HEAD),
  h("b", { text: kind === "codex" ? PLAN_TEXT.codexTitle : PLAN_TEXT.claudeTitle }));
  return h("div", { class: "plan-head" }, back, h("span", { class: "plan-sub", text: subtitle }),
    h("span", { class: "grow" }), extra);
}

function claudeCard(now: number): HTMLElement {
  const u = claudePlanUsage(now);
  return h("div", { class: "plan-card" },
    cardHead("claude", claudeSubtitle(u, now), now, null),
    h("div", { class: "plan-rows" },
      gaugeRow(PLAN_TEXT.fiveHours, u?.fiveHour, "hours", now),
      gaugeRow(PLAN_TEXT.week, u?.sevenDay, "week", now)));
}

function codexCard(now: number): HTMLElement {
  const u = codexPlanUsage();
  const resets = h("span", { class: "plan-chip" },
    h("span", { class: "plan-chip-label", text: PLAN_TEXT.resets }),
    h("b", { text: codexResetsLabel(u) }));
  const rows = h("div", { class: "plan-rows" });
  // Codex plans without a 5-hour window show the week alone, as on the Mac.
  if (u?.fiveHour) rows.append(gaugeRow(PLAN_TEXT.fiveHours, u.fiveHour, "hours", now));
  // A free plan's long window is 30 days, not a week.
  const mins = u?.longWindowMins;
  rows.append(gaugeRow(longWindowLabel(mins), u?.sevenDay, longWindowSpan(mins), now));
  return h("div", { class: "plan-card" }, cardHead("codex", codexSubtitle(u, codexAsking(), now), now, resets), rows);
}

/** The card that stands in for Home's card while a pill is open. */
export function buildPlanCard(kind: PlanKind, now = Date.now()): HTMLElement {
  return kind === "codex" ? codexCard(now) : claudeCard(now);
}
