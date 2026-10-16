// Plan usage gauges: the logic of ClaudePlanGauge.swift and CodexPlanGauge.swift
// on the Mac (ported from upstream Louis-CFM/coucou c02923e), with no DOM so it
// can be tested on its own. The pills and the card that show it are in
// views/plan.ts, their state in views/planState.ts.
//
// Claude: this build has no status line relay. The numbers are the ones the
// Claude pill already reads (quota.rs, from the status line files), mapped by
// planFromQuota. Pro and Max only.
// Codex: the numbers come from the Codex CLI itself (`codex app-server`,
// `account/rateLimits/read`, the source of Codex's /status), asked by the app
// when the pill shows. Nothing is read from any credentials, nothing is fetched
// by Coucou itself.

export interface PlanWindow {
  /** 0 to 100, clamped. */
  usedPct: number;
  /** Epoch milliseconds; null when the source did not say. */
  resetsAt: number | null;
}

export interface PlanUsage {
  fiveHour?: PlanWindow;
  sevenDay?: PlanWindow;
  /** When the numbers arrived (epoch ms). */
  updatedAt: number;
}

export interface CodexPlanUsage extends PlanUsage {
  /** Free full resets available. */
  resetCredits?: number;
  /** Soonest expiry among the available ones (epoch ms). */
  resetCreditExpiresAt?: number;
  planType?: string;
  /** Length of the long window when Codex gave it: 10080 is a week, a free plan's is 30 days. */
  longWindowMins?: number;
}

/** How a window's reset reads: a countdown, a weekday, or a date for windows longer than a week. */
export type PlanSpan = "hours" | "week" | "long";

const MS = 1000;
const MIN_S = 60;
const HOUR_S = 3600;
const DAY_MS = 86_400_000;
/** A reset further away than this is not epoch seconds (it is milliseconds in disguise). */
const MAX_RESET_DAYS = 400;
/** Codex windows of a day or less are the 5-hour one; a week is the usual long one. */
const DAY_MINS = 24 * 60;
const SHORT_WINDOW_MINS = DAY_MINS;
const WEEK_MINS = 7 * DAY_MINS;
const FULL_PCT = 100;

/** Every user-visible string of the gauges, in one place. */
export const PLAN_TEXT = {
  claudeTitle: "Claude plan",
  codexTitle: "Codex plan",
  claudePillTitle: "Claude plan usage",
  codexPillTitle: "Codex plan usage",
  back: "Back",
  waiting: "Waiting for the Claude Code status line",
  askingCodex: "Asking Codex…",
  codexSilent: "No answer from Codex. Is the CLI signed in?",
  justNow: "just now",
  minAgo: (n: number) => `${n} min ago`,
  hAgo: (n: number) => `${n} h ago`,
  fiveHours: "5 hours",
  week: "Week",
  days: (n: number) => `${n} days`,
  resets: "Resets",
  resetting: "Resetting…",
  inHM: (h: number, m: number) => `in ${h} h ${m}`,
  inM: (m: number) => `in ${m} min`,
  available: (n: number) => `${n} available`,
  until: (date: string) => ` · until ${date}`,
  none: "—",
};

/** The plan band colours (as on the Mac): no data, below 50 %, below 80 %, above. */
export const PLAN_COLORS = { none: "#6B7079", low: "#22C55E", mid: "#F59E0B", high: "#F4505E" };
const MID_PCT = 50;
const HIGH_PCT = 80;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const clampPct = (pct: number) => Math.min(FULL_PCT, Math.max(0, pct));

/** Epoch seconds to ms; null for 0 (unknown), a negative or an implausible date. */
function resetMs(epochS: unknown, now: number): number | null {
  if (!isNum(epochS) || epochS <= 0) return null;
  const ms = epochS * MS;
  return ms > now + MAX_RESET_DAYS * DAY_MS ? null : ms;
}

// ── Claude, from the Claude pill's data ───────────────────────────────────────

function quotaWindow(raw: unknown, now: number): PlanWindow | undefined {
  const w = asObj(raw);
  if (!w || !isNum(w.pct)) return undefined;
  return { usedPct: clampPct(w.pct), resetsAt: resetMs(w.resetsAt, now) };
}

/**
 * The Claude pill's snapshot (quota.rs QuotaSnapshot: `fiveHour` and `sevenDay`
 * as `{pct, resetsAt}` in epoch seconds, `updated` in epoch ms) as plan usage;
 * null while it holds neither window.
 */
export function planFromQuota(data: unknown, now = Date.now()): PlanUsage | null {
  const d = asObj(data);
  const updated = d?.updated;
  if (!d || !isNum(updated) || updated <= 0) return null;
  const fiveHour = quotaWindow(d.fiveHour, now);
  const sevenDay = quotaWindow(d.sevenDay, now);
  if (!fiveHour && !sevenDay) return null;
  const usage: PlanUsage = { updatedAt: updated };
  if (fiveHour) usage.fiveHour = fiveHour;
  if (sevenDay) usage.sevenDay = sevenDay;
  return usage;
}

// ── Codex ─────────────────────────────────────────────────────────────────────

interface CodexWindow {
  window: PlanWindow;
  mins: number | null;
}

function codexWindow(raw: unknown, now: number): CodexWindow | null {
  const w = asObj(raw);
  if (!w || !isNum(w.usedPercent) || !isNum(w.resetsAt)) return null;
  const mins = Number.isInteger(w.windowDurationMins) ? (w.windowDurationMins as number) : null;
  return { window: { usedPct: clampPct(w.usedPercent), resetsAt: resetMs(w.resetsAt, now) }, mins };
}

function addResetCredits(usage: CodexPlanUsage, raw: unknown) {
  const credits = asObj(raw);
  if (!credits) return;
  if (Number.isInteger(credits.availableCount)) usage.resetCredits = credits.availableCount as number;
  const expiries = (Array.isArray(credits.credits) ? credits.credits : [])
    .map(asObj)
    .filter((c) => c?.status === "available" && isNum(c.expiresAt))
    .map((c) => (c!.expiresAt as number) * MS);
  if (expiries.length) usage.resetCreditExpiresAt = Math.min(...expiries);
}

/**
 * CodexPlanGauge.parse: the result of `account/rateLimits/read`. `primary` and
 * `secondary` are not tied to a window, so they are sorted by duration: a day or
 * less is the 5-hour window, anything else (or no duration) the week.
 */
export function parseCodexPlan(result: unknown, now = Date.now()): CodexPlanUsage | null {
  const r = asObj(result);
  const limits = asObj(r?.rateLimits);
  if (!limits) return null;
  const usage: CodexPlanUsage = { updatedAt: now };
  if (typeof limits.planType === "string" && limits.planType) usage.planType = limits.planType;
  for (const key of ["primary", "secondary"]) {
    const parsed = codexWindow(limits[key], now);
    if (!parsed) continue;
    if (parsed.mins != null && parsed.mins <= SHORT_WINDOW_MINS) {
      usage.fiveHour = parsed.window;
      continue;
    }
    usage.sevenDay = parsed.window;
    if (parsed.mins != null) usage.longWindowMins = parsed.mins;
  }
  addResetCredits(usage, r?.rateLimitResetCredits);
  return usage.fiveHour || usage.sevenDay ? usage : null;
}

// ── Shared ────────────────────────────────────────────────────────────────────

/** What to show for a window: 0 once its reset time has passed. */
export const effectivePct = (w: PlanWindow, now = Date.now()): number =>
  w.resetsAt != null && w.resetsAt <= now ? 0 : w.usedPct;

/** The higher of the two effective percentages; null when there are no windows. */
export function dominantPct(u: PlanUsage | null | undefined, now = Date.now()): number | null {
  const pcts = [u?.fiveHour, u?.sevenDay].filter((w): w is PlanWindow => !!w).map((w) => effectivePct(w, now));
  return pcts.length ? Math.max(...pcts) : null;
}

/** Green below 50 %, orange up to 80 %, red above, grey without data. */
export function planColor(pct: number | null): string {
  if (pct == null) return PLAN_COLORS.none;
  if (pct < MID_PCT) return PLAN_COLORS.low;
  if (pct < HIGH_PCT) return PLAN_COLORS.mid;
  return PLAN_COLORS.high;
}

/** "Claude 73%" / "Codex 12%" on the pill; "Claude —" while there are no numbers. */
export function pillLabel(name: "Claude" | "Codex", u: PlanUsage | null | undefined, now = Date.now()): string {
  const pct = dominantPct(u, now);
  return pct == null ? `${name} ${PLAN_TEXT.none}` : `${name} ${Math.round(pct)}%`;
}

/** "just now", "12 min ago", "3 h ago". */
export function ageLabel(updatedAt: number, now = Date.now()): string {
  const secs = (now - updatedAt) / MS;
  if (secs < MIN_S) return PLAN_TEXT.justNow;
  const mins = Math.floor(secs / MIN_S);
  return mins < MIN_S ? PLAN_TEXT.minAgo(mins) : PLAN_TEXT.hAgo(Math.floor(mins / MIN_S));
}

/** The long window's row: "Week", or "30 days" for a longer one (Codex's free plan). */
export function longWindowLabel(mins: number | undefined): string {
  return mins == null || mins <= WEEK_MINS ? PLAN_TEXT.week : PLAN_TEXT.days(Math.round(mins / DAY_MINS));
}

/** How the long window's reset reads: a weekday within a week, a date past it. */
export const longWindowSpan = (mins: number | undefined): PlanSpan =>
  mins == null || mins <= WEEK_MINS ? "week" : "long";

const monthDay = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;

/** "in 1 h 20" / "in 5 min" for the 5-hour window, "Mon 9:00" for the week, "Nov 20" past it, "—" when unknown. */
export function resetLabel(w: PlanWindow, span: PlanSpan, now = Date.now()): string {
  if (w.resetsAt == null) return PLAN_TEXT.none;
  const secs = (w.resetsAt - now) / MS;
  if (secs <= 0) return PLAN_TEXT.resetting;
  const d = new Date(w.resetsAt);
  if (span === "long") return monthDay(d);
  if (span === "week") return `${WEEKDAYS[d.getDay()]} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const hours = Math.floor(secs / HOUR_S);
  const mins = Math.floor((secs % HOUR_S) / MIN_S);
  return hours > 0 ? PLAN_TEXT.inHM(hours, mins) : PLAN_TEXT.inM(mins);
}

/** The Claude card's subtitle. */
export function claudeSubtitle(u: PlanUsage | null, now = Date.now()): string {
  return u ? ageLabel(u.updatedAt, now) : PLAN_TEXT.waiting;
}

/** The Codex card's subtitle: "plus · 3 min ago"; while there is no answer, whether one is coming. */
export function codexSubtitle(u: CodexPlanUsage | null, asking: boolean, now = Date.now()): string {
  if (!u) return asking ? PLAN_TEXT.askingCodex : PLAN_TEXT.codexSilent;
  return (u.planType ? `${u.planType} · ` : "") + ageLabel(u.updatedAt, now);
}

/** "2 available · until Oct 9", or "—" when Codex said nothing about resets. */
export function codexResetsLabel(u: CodexPlanUsage | null): string {
  if (u?.resetCredits == null) return PLAN_TEXT.none;
  let text = PLAN_TEXT.available(u.resetCredits);
  if (u.resetCredits > 0 && u.resetCreditExpiresAt != null) {
    text += PLAN_TEXT.until(monthDay(new Date(u.resetCreditExpiresAt)));
  }
  return text;
}

/** How long a Codex answer (or a failed ask) stays good before the pill asks again (as on the Mac). */
export const CODEX_STALE_MS = 60_000;

/** True when Codex should be asked: no recent answer and no recent attempt. */
export function codexShouldAsk(u: CodexPlanUsage | null, lastAskedAt: number | null, now = Date.now()): boolean {
  const fresh = (at: number | null) => at != null && now - at < CODEX_STALE_MS;
  return !fresh(u?.updatedAt ?? null) && !fresh(lastAskedAt);
}
