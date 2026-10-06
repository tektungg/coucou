// Where an integration's alert lands. No DOM, tested alone.

/** Same prefix as sessions.ts SESSION_PREFIX; not imported, so node --test loads this alone. */
const SESSION_PREFIX = "cc_";

export interface AlertCandidate {
  id: string;
  /** performance.now() of the session's last hook event. */
  lastEventAt?: number;
}

/**
 * The pill that shows an alert from `id`: its own pill when it is on. The
 * Claude usage pill is off by default, but its 5-hour limit alerts still
 * matter: they go to the Claude Code session that was active last, else to
 * the catch-all Claude Code pill. Any other pill that is off has no alert.
 */
export function alertTarget(id: string, tasks: readonly AlertCandidate[]): string | null {
  if (tasks.some((t) => t.id === id)) return id;
  if (id !== "integration_quota") return null;
  let best: AlertCandidate | null = null;
  for (const t of tasks) {
    if (!t.id.startsWith(SESSION_PREFIX)) continue;
    if (best == null || (t.lastEventAt ?? 0) > (best.lastEventAt ?? 0)) best = t;
  }
  if (best) return best.id;
  return tasks.some((t) => t.id === "integration_claude") ? "integration_claude" : null;
}
