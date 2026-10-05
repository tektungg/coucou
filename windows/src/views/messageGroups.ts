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

/**
 * Which messages are expanded to their full text. The card is rebuilt on every
 * poll, so this outlives it; ids of messages no longer on the card are dropped.
 */
export class ExpandedMessages {
  private ids = new Set<number>();

  has(id: number): boolean {
    return this.ids.has(id);
  }

  /** Flips one message; returns whether it is now expanded. */
  toggle(id: number): boolean {
    if (this.ids.delete(id)) return false;
    this.ids.add(id);
    return true;
  }

  /** Forgets messages that left the card (opened, cleared, pushed out). */
  keepOnly(liveIds: Iterable<number>) {
    const live = new Set(liveIds);
    for (const id of this.ids) if (!live.has(id)) this.ids.delete(id);
  }

  get size(): number {
    return this.ids.size;
  }
}

/** A message needs the expand chevron when it has several lines or is cut off. */
export function needsExpander(text: string, overflowing: boolean): boolean {
  return overflowing || text.includes("\n");
}
