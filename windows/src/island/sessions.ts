// One pill per Claude Code session. No DOM, no Tauri: ids, colours and the
// ordering rules, so they can be tested on their own.

export const SESSION_PREFIX = "cc_";

/** A session nobody has heard from in this long is swept from the pills. */
export const SESSION_IDLE_SWEEP_MS = 2 * 60 * 60 * 1000;

/** Distinct from the integration colours, and readable on the dark island. */
export const SESSION_COLORS = ["#F5F6F8", "#60A5FA", "#A78BFA", "#34D399", "#FBBF24", "#F472B6"];

/** The minimum a pill needs for the rules below. */
export interface SessionLike {
  id: string;
  color: string;
  lastEventAt?: number;
  state?: string;
}

/** `cc_` + the session id's first 8 hex digits: stable, short, and unique enough. */
export function sessionPillId(sessionId: string): string {
  const hex = sessionId.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length >= 8) return SESSION_PREFIX + hex.slice(0, 8);
  // Not a UUID: fall back to a hash so the id is still stable and safe.
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (Math.imul(31, h) + sessionId.charCodeAt(i)) | 0;
  return SESSION_PREFIX + (h >>> 0).toString(16).padStart(8, "0");
}

export function isSessionPill(id: string): boolean {
  return id.startsWith(SESSION_PREFIX);
}

/**
 * Which pill a hook event belongs to: an external agent's own pill, else the
 * Claude Code session's pill, else (no session id at all) the catch-all one.
 */
export function routeHook(agent: string | null, sessionId: string): string {
  if (agent) return `agent_${agent}`;
  if (sessionId.trim()) return sessionPillId(sessionId);
  return "integration_claude";
}

/** The first palette colour no live session uses; after that, a stable pick. */
export function sessionColor(sessionId: string, inUse: string[]): string {
  const free = SESSION_COLORS.find((c) => !inUse.includes(c));
  if (free) return free;
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (Math.imul(31, h) + sessionId.charCodeAt(i)) | 0;
  return SESSION_COLORS[Math.abs(h) % SESSION_COLORS.length];
}

/** Most recently active session first; sessions keep ahead of everything else. */
export function compareSessions(a: SessionLike, b: SessionLike): number {
  return (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0);
}

/**
 * Sessions to drop: quiet for longer than the sweep window and not mid-task.
 * A session waiting on a human (approval, question) is never swept.
 */
export function staleSessions(tasks: SessionLike[], nowMs: number, keep: string | null): string[] {
  return tasks
    .filter((t) => isSessionPill(t.id) && t.id !== keep)
    .filter((t) => t.state !== "approval" && t.state !== "question")
    .filter((t) => nowMs - (t.lastEventAt ?? 0) > SESSION_IDLE_SWEEP_MS)
    .map((t) => t.id);
}

/**
 * Events that prove a session moved past its pending card: the tool it asked
 * about ran (or failed), the user typed a new prompt, or the turn ended. A
 * different tool running in parallel proves nothing and is ignored.
 */
export function resolvesCard(event: string, tool: string | undefined, cardTool: string): boolean {
  if (event === "UserPromptSubmit" || event === "Stop" || event === "StopFailure" || event === "SessionEnd") {
    return true;
  }
  return (event === "PostToolUse" || event === "PostToolUseFailure") && tool === cardTool;
}
