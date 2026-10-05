// Messages card: one group per app. No DOM here, tested alone.

export interface MessageGroup<T> {
  /** "discord", "slack"…, or "" when the message names no app. */
  app: string;
  items: T[];
}

/**
 * Groups messages by app. The input is newest first (the poller's history), so
 * the app with the latest message leads and each group stays newest first.
 */
export function groupByApp<T extends { app?: unknown }>(messages: readonly T[]): MessageGroup<T>[] {
  const groups = new Map<string, MessageGroup<T>>();
  for (const m of messages) {
    const app = typeof m.app === "string" ? m.app : "";
    let g = groups.get(app);
    if (!g) {
      g = { app, items: [] };
      groups.set(app, g);
    }
    g.items.push(m);
  }
  return [...groups.values()];
}
