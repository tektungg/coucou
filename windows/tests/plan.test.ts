// Plan usage gauges (src/core/plan.ts), the pills' state (src/views/planState.ts),
// the pills and the card (src/views/plan.ts) and Home's plan mode
// (src/views/overview.ts). Ported from upstream tests/plan.test.mjs
// (Louis-CFM/coucou c02923e): the Mac's ClaudePlanGaugeTests.swift, the Codex
// parsing of CodexPlanGauge.swift and the pills' rules. This build has no status
// line relay, so the Claude half reads the Claude pill's quota.rs snapshot.
// Run with `npm test`.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS helper, no types
import { answer, resetCalls, sent } from "./tauri.mjs";
// @ts-expect-error plain JS helper, no types
import { installFakeDom } from "./fakedom.mjs";
import {
  CODEX_STALE_MS, PLAN_COLORS, PLAN_TEXT, ageLabel, claudeSubtitle, codexResetsLabel, codexShouldAsk,
  codexSubtitle, dominantPct, effectivePct, longWindowLabel, longWindowSpan, parseCodexPlan, pillLabel,
  planColor, planFromQuota, resetLabel, type PlanWindow,
} from "../src/core/plan.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { PAGER_MAX_W, PLAN_PILL_W, pagerBudget, pagerChips } from "../src/views/pager.ts";
import {
  claudePillVisible, claudePlanUsage, closePlanCard, codexAsking, codexPillVisible, codexPlanUsage, openPlanKind,
  planCardColor, planCardOpen, refreshCodexPlanUsage, resetCodexPlanUsage, setCodexPlanUsage, togglePlanCard,
  visiblePlanPills,
} from "../src/views/planState.ts";

installFakeDom();
const { buildPlanCard, buildPlanPills, planCardKey, PLAN_CLOCK_MS } = await import("../src/views/plan.ts");
const { buildOverview } = await import("../src/views/overview.ts");

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const NOW_S = NOW / 1000;
const future = NOW_S + 7200; // 2 hours from now, epoch seconds
const past = NOW_S - 100;
const win = (pct: number, epochS: number | null): PlanWindow => ({
  usedPct: pct,
  resetsAt: epochS == null ? null : epochS * 1000,
});
const quota = (five: unknown, seven: unknown, updated = NOW - 60_000) => ({
  fiveHour: five, sevenDay: seven, sessions: [], totalCost: 0, updated,
});

// ── planFromQuota: the Claude pill's snapshot ─────────────────────────────────

test("a full snapshot gives both windows, with the reset in ms and the file time as its age", () => {
  const u = planFromQuota(quota({ pct: 23.5, resetsAt: future }, { pct: 67, resetsAt: future }), NOW)!;
  assert.equal(u.fiveHour!.usedPct, 23.5);
  assert.equal(u.sevenDay!.usedPct, 67);
  assert.equal(u.fiveHour!.resetsAt, future * 1000);
  assert.equal(u.updatedAt, NOW - 60_000);
});

test("no snapshot, no windows or no file time is nothing", () => {
  assert.equal(planFromQuota(undefined, NOW), null);
  assert.equal(planFromQuota("x", NOW), null);
  assert.equal(planFromQuota({}, NOW), null);
  assert.equal(planFromQuota(quota(null, null), NOW), null);
  assert.equal(planFromQuota(quota({ pct: 10, resetsAt: future }, null, 0), NOW), null);
  assert.equal(planFromQuota(quota({ pct: "10", resetsAt: future }, null), NOW), null);
});

test("one good window is enough, and percentages are clamped", () => {
  const u = planFromQuota(quota({ pct: "bad" }, { pct: 150, resetsAt: future }), NOW)!;
  assert.equal(u.fiveHour, undefined);
  assert.equal(u.sevenDay!.usedPct, 100);
  assert.equal(planFromQuota(quota({ pct: -5, resetsAt: future }, null), NOW)!.fiveHour!.usedPct, 0);
});

test("an unknown reset (0, missing, or ms in disguise) keeps the percentage", () => {
  const reset = (resetsAt: unknown) => planFromQuota(quota({ pct: 40, resetsAt }, null), NOW)!.fiveHour!;
  assert.deepEqual(reset(0), { usedPct: 40, resetsAt: null });
  assert.deepEqual(reset(undefined), { usedPct: 40, resetsAt: null });
  assert.equal(reset(NOW).resetsAt, null);
  assert.equal(reset(NOW_S + 401 * 86_400).resetsAt, null);
  assert.equal(effectivePct(reset(0), NOW), 40);
  assert.equal(resetLabel(reset(0), "hours", NOW), PLAN_TEXT.none);
});

// ── effectivePct / dominantPct ────────────────────────────────────────────────

test("a window whose reset has passed counts as 0", () => {
  assert.equal(effectivePct(win(80, past), NOW), 0);
  assert.equal(effectivePct(win(80, future), NOW), 80);
});

test("the dominant percentage is the higher window", () => {
  assert.equal(dominantPct({ fiveHour: win(30, future), sevenDay: win(70, future), updatedAt: NOW }, NOW), 70);
  assert.equal(dominantPct({ fiveHour: win(55, future), updatedAt: NOW }, NOW), 55);
  assert.equal(dominantPct({ updatedAt: NOW }, NOW), null);
  assert.equal(dominantPct(null, NOW), null);
  // An expired week no longer dominates.
  assert.equal(dominantPct({ fiveHour: win(30, future), sevenDay: win(90, past), updatedAt: NOW }, NOW), 30);
});

// ── colours and labels ────────────────────────────────────────────────────────

test("colours: grey, then green below 50, orange below 80, red", () => {
  assert.equal(planColor(null), PLAN_COLORS.none);
  assert.equal(planColor(0), "#22C55E");
  assert.equal(planColor(49), "#22C55E");
  assert.equal(planColor(50), "#F59E0B");
  assert.equal(planColor(79), "#F59E0B");
  assert.equal(planColor(80), "#F4505E");
  assert.equal(planColor(100), "#F4505E");
});

test("pill labels read like the Mac's header pill", () => {
  const both = { fiveHour: win(30, future), sevenDay: win(70, future), updatedAt: NOW };
  assert.equal(pillLabel("Claude", null, NOW), "Claude —");
  assert.equal(pillLabel("Claude", { updatedAt: NOW }, NOW), "Claude —");
  assert.equal(pillLabel("Claude", both, NOW), "Claude 70%");
  assert.equal(pillLabel("Codex", { sevenDay: win(12.4, future), updatedAt: NOW }, NOW), "Codex 12%");
  assert.equal(pillLabel("Codex", null, NOW), "Codex —");
});

test("reset times: a countdown for 5 hours, a weekday for the week, a date past a week", () => {
  assert.equal(resetLabel(win(10, NOW_S + 4800), "hours", NOW), "in 1 h 20");
  assert.equal(resetLabel(win(10, NOW_S + 300), "hours", NOW), "in 5 min");
  assert.equal(resetLabel(win(10, past), "hours", NOW), "Resetting…");
  const at = new Date(2026, 9, 12, 9, 5); // a Monday, local time
  assert.equal(resetLabel({ usedPct: 1, resetsAt: at.getTime() }, "week", at.getTime() - 3600_000), "Mon 9:05");
  assert.equal(resetLabel({ usedPct: 1, resetsAt: at.getTime() }, "long", at.getTime() - 3600_000), "Oct 12");
});

test("subtitles say how old the numbers are", () => {
  assert.equal(claudeSubtitle(null, NOW), PLAN_TEXT.waiting);
  assert.equal(claudeSubtitle({ updatedAt: NOW - 30_000 }, NOW), "just now");
  assert.equal(claudeSubtitle({ updatedAt: NOW - 12 * 60_000 }, NOW), "12 min ago");
  assert.equal(ageLabel(NOW - 3 * 3600_000, NOW), "3 h ago");
  assert.equal(codexSubtitle(null, true, NOW), "Asking Codex…");
  assert.equal(codexSubtitle(null, false, NOW), PLAN_TEXT.codexSilent);
  assert.equal(codexSubtitle({ planType: "plus", updatedAt: NOW - 120_000 }, false, NOW), "plus · 2 min ago");
});

// ── CodexPlanGauge.parse ──────────────────────────────────────────────────────

test("Codex windows are sorted by duration, not by primary/secondary", () => {
  const u = parseCodexPlan({
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 64, resetsAt: future + 86400, windowDurationMins: 10080 },
      secondary: { usedPercent: 12.5, resetsAt: future, windowDurationMins: 300 },
    },
  }, NOW)!;
  assert.equal(u.planType, "plus");
  assert.equal(u.fiveHour!.usedPct, 12.5);
  assert.equal(u.sevenDay!.usedPct, 64);
  assert.equal(u.sevenDay!.resetsAt, (future + 86400) * 1000);
  assert.equal(longWindowLabel(u.longWindowMins), "Week");
  assert.equal(longWindowSpan(u.longWindowMins), "week");
});

test("a Codex window without a duration is the week; percentages are clamped", () => {
  const u = parseCodexPlan({ rateLimits: { primary: { usedPercent: 140, resetsAt: future } } }, NOW)!;
  assert.equal(u.fiveHour, undefined);
  assert.equal(u.sevenDay!.usedPct, 100);
  assert.equal(u.longWindowMins, undefined);
  const low = parseCodexPlan({ rateLimits: { primary: { usedPercent: -3, resetsAt: future } } }, NOW)!;
  assert.equal(low.sevenDay!.usedPct, 0);
});

test("a free plan's 30-day window reads as 30 days with a date (a real app-server answer)", () => {
  const u = parseCodexPlan({
    rateLimits: {
      limitId: "codex", primary: { usedPercent: 0, windowDurationMins: 43200, resetsAt: NOW_S + 20 * 86_400 },
      secondary: null, credits: { hasCredits: false, unlimited: false, balance: null }, planType: "free",
    },
    rateLimitResetCredits: { availableCount: 0, credits: [] },
  }, NOW)!;
  assert.equal(u.planType, "free");
  assert.equal(u.longWindowMins, 43200);
  assert.equal(longWindowLabel(u.longWindowMins), "30 days");
  assert.equal(longWindowSpan(u.longWindowMins), "long");
  assert.equal(codexResetsLabel(u), "0 available");
});

test("free resets: the count and the soonest available expiry", () => {
  const u = parseCodexPlan({
    rateLimits: { primary: { usedPercent: 5, resetsAt: future, windowDurationMins: 10080 } },
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { status: "available", expiresAt: Date.UTC(2026, 10, 20, 12) / 1000 },
        { status: "used", expiresAt: Date.UTC(2026, 9, 1, 12) / 1000 },
        { status: "available", expiresAt: Date.UTC(2026, 9, 9, 12) / 1000 },
      ],
    },
  }, NOW)!;
  assert.equal(u.resetCredits, 2);
  assert.equal(u.resetCreditExpiresAt, Date.UTC(2026, 9, 9, 12));
  assert.equal(codexResetsLabel(u), "2 available · until Oct 9");
  assert.equal(codexResetsLabel({ ...u, resetCredits: 0 }), "0 available");
  assert.equal(codexResetsLabel({ updatedAt: NOW }), "—");
  assert.equal(codexResetsLabel(null), "—");
});

test("no Codex limits, or only broken ones, is nothing", () => {
  assert.equal(parseCodexPlan(null, NOW), null);
  assert.equal(parseCodexPlan({}, NOW), null);
  assert.equal(parseCodexPlan({ rateLimits: { primary: { usedPercent: "5", resetsAt: future } } }, NOW), null);
  assert.equal(parseCodexPlan({ rateLimits: { primary: { usedPercent: 5 } } }, NOW), null);
});

test("Codex is asked again only once its numbers, or the last attempt, are a minute old", () => {
  assert.equal(codexShouldAsk(null, null, NOW), true);
  assert.equal(codexShouldAsk({ updatedAt: NOW - 59_000 }, null, NOW), false);
  assert.equal(codexShouldAsk({ updatedAt: NOW - CODEX_STALE_MS }, null, NOW), true);
  // A failed attempt (no numbers) is not retried at every open either.
  assert.equal(codexShouldAsk(null, NOW - 10_000, NOW), false);
  assert.equal(codexShouldAsk(null, NOW - CODEX_STALE_MS, NOW), true);
});

// ── The pills' state ──────────────────────────────────────────────────────────

const ok = (data: Record<string, unknown>) => ({ loaded: true, configured: true, error: null, data });
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  State.settings = { ...DEFAULT_SETTINGS };
  State.view = "overview";
  State.mode = "expanded";
  State.paused = false;
  State.tasks = [];
  State.focusId = null;
  State.integrations = {};
  closePlanCard();
  resetCodexPlanUsage();
  resetCalls();
});

test("both pills are off by default, so the header and the pager are as they shipped", () => {
  assert.equal(DEFAULT_SETTINGS.showPlanInNotch, false);
  assert.equal(DEFAULT_SETTINGS.showCodexPlanInNotch, false);
  assert.equal(claudePillVisible(), false);
  assert.equal(codexPillVisible(), false);
  assert.equal(visiblePlanPills(), 0);
  assert.equal(pagerBudget(visiblePlanPills()), PAGER_MAX_W);
});

test("each pill needs its switch and the overview", () => {
  State.settings.showPlanInNotch = true;
  assert.equal(claudePillVisible(), true);
  assert.equal(codexPillVisible(), false);
  State.settings.showCodexPlanInNotch = true;
  assert.equal(visiblePlanPills(), 2);
  State.view = "prompt";
  assert.equal(claudePillVisible(), false);
  assert.equal(codexPillVisible(), false);
});

test("the Claude numbers are the Claude pill's, whether or not that pill is on", () => {
  assert.equal(claudePlanUsage(NOW), null);
  State.integrations.integration_quota = ok(quota({ pct: 73, resetsAt: future }, null));
  assert.equal(claudePlanUsage(NOW)!.fiveHour!.usedPct, 73);
});

test("a click opens a card, a second closes it, the other pill swaps it", () => {
  State.settings.showPlanInNotch = true;
  State.settings.showCodexPlanInNotch = true;
  togglePlanCard("claude");
  assert.equal(openPlanKind(), "claude");
  togglePlanCard("codex");
  assert.equal(openPlanKind(), "codex");
  togglePlanCard("codex");
  assert.equal(planCardOpen(), false);
});

test("the card closes when the island shuts, Home is left, the focus moves or the pill goes", () => {
  State.settings.showPlanInNotch = true;
  State.loadIntegrationTasks();
  const close = (change: () => void) => {
    togglePlanCard("claude");
    assert.equal(planCardOpen(), true);
    change();
    State.notify();
    assert.equal(planCardOpen(), false);
  };
  close(() => (State.mode = "compact"));
  State.mode = "expanded";
  close(() => (State.view = "prompt"));
  State.view = "overview";
  close(() => State.setFocus(State.tasks[State.tasks.length - 1].id));
  close(() => (State.settings.showPlanInNotch = false));
  // And it is not back when the island opens again.
  State.settings.showPlanInNotch = true;
  assert.equal(planCardOpen(), false);
});

test("a card open when the island shut is not there when it opens again", () => {
  State.settings.showPlanInNotch = true;
  togglePlanCard("claude");
  State.mode = "compact";
  State.notify(); // what Island.setMode does; nothing reads the card while shut
  State.mode = "expanded";
  assert.equal(planCardOpen(), false);
});

test("Mochi wears the open plan's colour, and his own once it closes", () => {
  State.settings.showPlanInNotch = true;
  State.integrations.integration_quota = ok(quota({ pct: 85, resetsAt: Date.now() / 1000 + 3600 }, null, Date.now()));
  assert.equal(planCardColor(), null);
  togglePlanCard("claude");
  assert.equal(planCardColor(), PLAN_COLORS.high);
  closePlanCard();
  assert.equal(planCardColor(), null);
});

test("Codex is asked once, not while paused, and its answer becomes the numbers", async () => {
  State.paused = true;
  refreshCodexPlanUsage();
  assert.equal(sent("codex_plan_usage").length, 0);
  State.paused = false;
  answer("codex_plan_usage", {
    rateLimits: { planType: "plus", primary: { usedPercent: 12, resetsAt: Date.now() / 1000 + 600, windowDurationMins: 300 } },
  });
  refreshCodexPlanUsage();
  assert.equal(codexAsking(), true);
  refreshCodexPlanUsage(); // already asking
  await settle();
  assert.equal(sent("codex_plan_usage").length, 1);
  assert.equal(codexAsking(), false);
  assert.equal(codexPlanUsage()!.fiveHour!.usedPct, 12);
  refreshCodexPlanUsage(); // fresh numbers
  assert.equal(sent("codex_plan_usage").length, 1);
});

test("no answer from Codex keeps the pill on a dash and is not retried within the minute", async () => {
  const at = Date.now();
  refreshCodexPlanUsage(at);
  await settle();
  assert.equal(codexPlanUsage(), null);
  refreshCodexPlanUsage(at + 10_000);
  assert.equal(sent("codex_plan_usage").length, 1);
  refreshCodexPlanUsage(at + CODEX_STALE_MS);
  await settle();
  assert.equal(sent("codex_plan_usage").length, 2);
});

test("opening the Codex card asks Codex", () => {
  State.settings.showCodexPlanInNotch = true;
  togglePlanCard("codex");
  assert.equal(sent("codex_plan_usage").length, 1);
});

// ── Pager room ────────────────────────────────────────────────────────────────

test("each plan pill takes its room from the pager", () => {
  assert.equal(pagerBudget(2), PAGER_MAX_W - 2 * PLAN_PILL_W);
  const pills = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `Pill ${i}` }));
  const roomy = pagerChips(pills, "p0", pagerBudget(0));
  const tight = pagerChips(pills, "p0", pagerBudget(2));
  assert.equal(roomy.overflow, null);
  assert.ok(tight.chips.length < roomy.chips.length);
  assert.equal(tight.overflow!.count, pills.length - tight.chips.length);
});

// ── Pills and card (DOM) ──────────────────────────────────────────────────────

test("the pills stay hidden while off, and read 'Claude 73%' once on", () => {
  const pills = buildPlanPills();
  pills.sync();
  assert.deepEqual(pills.els.map((el) => el.style.display), ["none", "none"]);
  State.settings.showPlanInNotch = true;
  State.integrations.integration_quota = ok(quota({ pct: 73, resetsAt: Date.now() / 1000 + 3600 }, null, Date.now()));
  pills.sync();
  assert.deepEqual(pills.els.map((el) => el.style.display), ["", "none"]);
  assert.equal(pills.els[0].textContent, "Claude 73%");
  pills.els[0].fire("click");
  pills.sync();
  assert.equal(pills.els[0].classList.contains("on"), true);
});

test("the Codex pill asks Codex when it comes into view, once", () => {
  const pills = buildPlanPills();
  State.settings.showCodexPlanInNotch = true;
  pills.sync();
  pills.sync();
  assert.equal(sent("codex_plan_usage").length, 1);
});

test("the Claude card shows both windows; the Codex card its plan, free resets and long window", () => {
  const now = Date.now();
  State.integrations.integration_quota = ok(quota({ pct: 73, resetsAt: now / 1000 + 4800 }, { pct: 41, resetsAt: 0 }, now));
  const claude = buildPlanCard("claude", now);
  assert.match(claude.textContent, /Claude plan/);
  assert.match(claude.textContent, /5 hours.*73%.*in 1 h 20/);
  assert.match(claude.textContent, /Week.*41%—/);
  setCodexPlanUsage(parseCodexPlan({
    rateLimits: { planType: "free", primary: { usedPercent: 4, resetsAt: now / 1000 + 86_400, windowDurationMins: 43200 } },
    rateLimitResetCredits: { availableCount: 1, credits: [] },
  }, now));
  const codex = buildPlanCard("codex", now);
  assert.match(codex.textContent, /Codex planfree · just now/);
  assert.match(codex.textContent, /Resets1 available/);
  assert.match(codex.textContent, /30 days.*4%/);
  assert.doesNotMatch(codex.textContent, /5 hours/);
});

test("the card is redrawn on a new beat or new numbers only", () => {
  const t = 1_000 * PLAN_CLOCK_MS;
  assert.equal(planCardKey("claude", t), planCardKey("claude", t + PLAN_CLOCK_MS - 1));
  assert.notEqual(planCardKey("claude", t), planCardKey("claude", t + PLAN_CLOCK_MS));
  const before = planCardKey("claude", t);
  State.integrations.integration_quota = ok(quota({ pct: 5, resetsAt: future }, null));
  assert.notEqual(planCardKey("claude", t), before);
});

// ── Home's plan mode ──────────────────────────────────────────────────────────

const ACTIONS = new Proxy({}, { get: () => () => {} }) as Parameters<typeof buildOverview>[0];
// Home's carousel listens for the mouse on the window, which Node's global is not.
const win0 = globalThis as unknown as { addEventListener?: () => void };
win0.addEventListener ??= () => {};

test("Home shows the plan card in place of the focused pill's card, and gives it back", () => {
  State.settings.showPlanInNotch = true;
  State.loadIntegrationTasks();
  const overview = buildOverview(ACTIONS);
  overview.sync();
  const body = () => overview.el.querySelector(".left-body")!;
  assert.equal(body().querySelector(".plan-card"), null);
  togglePlanCard("claude");
  overview.sync();
  assert.notEqual(body().querySelector(".plan-card"), null);
  togglePlanCard("claude");
  overview.sync();
  assert.equal(body().querySelector(".plan-card"), null);
  assert.ok(body().children.length > 0, "the pill's own card is back");
});
