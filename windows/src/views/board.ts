// Home's session board (Mochi Pop): a speech bubble summing up the agent
// sessions and a row of tiles, one per session, the ones that need you first.
// Pure (its only import, core/diff.ts, is pure too), so tests/board.test.ts
// covers every state.

import { parseDiffStep } from "../core/diff";

/** The parts of a session pill the board reads (core/state.ts AgentTask). */
export interface BoardSession {
  id: string;
  name: string;
  color: string;
  state: string;
  steps: string[];
  stepIndex: number;
  /** performance.now() of its last hook event. */
  lastEventAt?: number;
  /** Context use and cost, from Claude Code's statusline. */
  ctxPct?: number;
  costUsd?: number;
}

export type BoardMark = "done" | "ask" | "error";

/** The +N −M of the file edit a session is on, and the diff it opens. */
export interface BoardDiff {
  added: number;
  removed: number;
  diffId: number;
}

export interface BoardTile {
  id: string;
  name: string;
  color: string;
  /** Current step or state, and how long ago it last moved. */
  line: string;
  /** "ctx 45% · $1.20", when the statusline reported it. */
  usage: string | null;
  mark: BoardMark | null;
  /** Set while the step is a file edit (live diff, core/diff.ts). */
  diff: BoardDiff | null;
  /** The focused session. */
  active: boolean;
}

export interface Board {
  bubble: string;
  tiles: BoardTile[];
  /** Sessions that did not fit, and the one the "+N" tile focuses. */
  more: { count: number; nextId: string } | null;
}

/** Tiles that fit the card's one row; past it the last slot becomes "+N". */
export const MAX_TILES = 3;
/** Sessions named in the bubble before "+N more". */
const BUBBLE_CLAUSES = 2;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const WORKING = new Set(["working", "thinking", "searching"]);

/** Who needs you comes first; then errors, work in progress, the rest. */
const PRIORITY: Record<string, number> = {
  approval: 0, question: 0, error: 1, working: 2, thinking: 2, searching: 2, ratelimit: 3, finished: 4,
};
const IDLE_PRIORITY = 5;

/** The tile's line for a state with no step to show. */
const LABEL: Record<string, string> = {
  approval: "needs you", question: "has a question", error: "hit an error", finished: "done",
  working: "working", thinking: "thinking", searching: "searching", ratelimit: "rate limited",
};
/** The same state, as the bubble says it after the session's name. */
const PHRASE: Record<string, string> = {
  approval: "needs you", question: "has a question", error: "hit an error", finished: "is done",
  working: "is working", thinking: "is thinking", searching: "is searching", ratelimit: "is rate limited",
};

const MARK: Record<string, BoardMark> = { finished: "done", approval: "ask", question: "ask", error: "error" };

export const stateLabel = (state: string) => LABEL[state] ?? "idle";

/** "now", "3 min", "2 h". */
export function ago(ms: number): string {
  if (ms < MINUTE_MS) return "now";
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min`;
  return `${Math.floor(ms / HOUR_MS)} h`;
}

/** The step a working session is on, if it has one; a file edit reads "Edited <file>". */
function currentStep(s: BoardSession): { text: string; diff: BoardDiff | null } | null {
  if (!WORKING.has(s.state) || s.steps.length === 0) return null;
  const step = s.steps[Math.min(Math.max(s.stepIndex, 0), s.steps.length - 1)];
  const edit = parseDiffStep(step);
  if (!edit) return { text: step, diff: null };
  const { added, removed, diffId } = edit;
  return { text: `Edited ${edit.filename}`, diff: { added, removed, diffId } };
}

export function usageOf(s: Pick<BoardSession, "ctxPct" | "costUsd">): string | null {
  const parts = [
    s.ctxPct != null ? `ctx ${Math.round(s.ctxPct)}%` : "",
    s.costUsd != null ? `$${s.costUsd.toFixed(2)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function tileOf(s: BoardSession, focusId: string, nowMs: number): BoardTile {
  const step = currentStep(s);
  const what = step?.text ?? stateLabel(s.state);
  const when = s.lastEventAt != null ? ` · ${ago(nowMs - s.lastEventAt)}` : "";
  return {
    id: s.id, name: s.name, color: s.color, line: what + when, usage: usageOf(s),
    mark: MARK[s.state] ?? null, diff: step?.diff ?? null, active: s.id === focusId,
  };
}

function clause(s: BoardSession): string {
  const step = currentStep(s);
  return step ? `${s.name}: ${step.text}` : `${s.name} ${PHRASE[s.state] ?? "is idle"}`;
}

function bubbleOf(ordered: BoardSession[]): string {
  if (ordered.length === 0) return "No agent sessions right now.";
  const named = ordered.slice(0, BUBBLE_CLAUSES);
  const rest = ordered.length - named.length;
  const sparkle = named.some((s) => s.state === "finished") ? " ✨" : "";
  return named.map(clause).join(" · ") + (rest > 0 ? ` · +${rest} more` : "") + sparkle;
}

/** Sessions by priority (stable), with the focused one moved into the shown slots. */
function shownSessions(ordered: BoardSession[], focusId: string): BoardSession[] {
  if (ordered.length <= MAX_TILES) return ordered;
  const slots = MAX_TILES - 1; // the last slot is the "+N" tile
  const shown = ordered.slice(0, slots);
  const focused = ordered.find((s) => s.id === focusId);
  if (focused && !shown.includes(focused)) shown[slots - 1] = focused;
  return shown;
}

export function sessionBoard(sessions: BoardSession[], focusId: string, nowMs: number): Board {
  const rank = (s: BoardSession) => PRIORITY[s.state] ?? IDLE_PRIORITY;
  const ordered = sessions.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(({ s }) => s);
  const shown = shownSessions(ordered, focusId);
  const hidden = ordered.filter((s) => !shown.includes(s));
  return {
    bubble: bubbleOf(ordered),
    tiles: shown.map((s) => tileOf(s, focusId, nowMs)),
    more: hidden.length > 0 ? { count: hidden.length, nextId: hidden[0].id } : null,
  };
}
