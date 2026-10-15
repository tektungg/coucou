// Messages card: messages folded into chats, the app filter, the row labels.
// No DOM here, tested alone.

/** Brand colours of the apps the Messages pill reads. */
export const APP_COLORS: Record<string, string> = {
  discord: "#5865F2", slack: "#E01E5A", telegram: "#26A5E4", whatsapp: "#25D366",
};
export const APP_NAMES: Record<string, string> = {
  discord: "Discord", slack: "Slack", telegram: "Telegram", whatsapp: "WhatsApp",
};
/** For a message that names no app the card knows. */
export const OTHER_COLOR = "#8e939c";

/** The fields of a polled message the card reads (personal.rs, notify::Message). */
export interface MessageLike {
  id?: unknown;
  app?: unknown;
  sender?: unknown;
  place?: unknown;
  channel?: unknown;
  text?: unknown;
  at?: unknown;
}

/** One row of the card: every message of one chat. */
export interface Thread<T> {
  key: string;
  /** "discord", "slack"…, or "" when the message names no app. */
  app: string;
  /** The DM's sender, or "Server › #channel" for a group or channel. */
  title: string;
  isGroup: boolean;
  /** Newest first, like the poller's history. */
  items: T[];
  latestAt: number;
}

/** "all", or the app the chips narrowed the card to. */
export type AppFilter = string;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** "Server › #channel", "Workspace › #channel", "#channel", or "" for a DM. */
export function messagePlace(m: { place?: unknown; channel?: unknown }): string {
  return [str(m.place), str(m.channel)].filter(Boolean).join(" › ");
}

/** A group or channel is one chat whoever writes in it; a DM is one chat per sender. */
export function threadKey(m: MessageLike): string {
  const app = str(m.app);
  const place = messagePlace(m);
  return place ? `${app}|g|${place}` : `${app}|dm|${str(m.sender)}`;
}

/**
 * Folds messages into chats. The input is newest first (the poller's history),
 * so the chat with the latest message leads and each chat stays newest first.
 */
export function threadsOf<T extends MessageLike>(messages: readonly T[]): Thread<T>[] {
  const threads = new Map<string, Thread<T>>();
  for (const m of messages) {
    const key = threadKey(m);
    let t = threads.get(key);
    if (!t) {
      const app = str(m.app);
      const place = messagePlace(m);
      t = {
        key,
        app,
        title: place || str(m.sender) || APP_NAMES[app] || "Message",
        isGroup: place !== "",
        items: [],
        latestAt: typeof m.at === "number" ? m.at : 0,
      };
      threads.set(key, t);
    }
    t.items.push(m);
  }
  return [...threads.values()];
}

/** Messages per app, the app with the newest message first, for the filter chips. */
export function appCounts(messages: readonly MessageLike[]): { app: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    const app = str(m.app);
    counts.set(app, (counts.get(app) ?? 0) + 1);
  }
  return [...counts].map(([app, count]) => ({ app, count }));
}

/** The filter actually in force: back to "all" once its app has nothing left on the card. */
export function effectiveFilter(filter: AppFilter, threads: readonly Thread<unknown>[]): AppFilter {
  return filter !== "all" && threads.some((t) => t.app === filter) ? filter : "all";
}

export function filterThreads<T>(threads: readonly Thread<T>[], filter: AppFilter): Thread<T>[] {
  const f = effectiveFilter(filter, threads);
  return f === "all" ? [...threads] : threads.filter((t) => t.app === f);
}

/** The ids of a chat's messages, for opening or dismissing the whole chat. */
export function threadIds(t: Thread<MessageLike>): number[] {
  return t.items.map((m) => m.id).filter((id): id is number => typeof id === "number");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The avatar's letter: the chat name's first character (a whole emoji or kana), upper case. */
export function avatarLetter(title: string): string {
  const first = segmenter.segment(title.trim())[Symbol.iterator]().next();
  return first.done ? "?" : first.value.segment.toLocaleUpperCase();
}

/** "now", "5m", "2h", "3d": short enough for the row's corner. */
export function shortAgo(atMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, (nowMs - atMs) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Fresh enough for the accent colour on the row's time. */
export function isFresh(atMs: number, nowMs = Date.now()): boolean {
  return nowMs - atMs < 60_000;
}

/** One message's line in a group says who wrote it; in a DM the title already does. */
export function messageLine(m: MessageLike, isGroup: boolean): string {
  const text = str(m.text);
  const sender = str(m.sender);
  // A Telegram group can name the group as the sender: no point saying it twice.
  return isGroup && sender && sender !== str(m.place) ? `${sender}: ${text}` : text;
}

/** The row's second line: the chat's latest message. */
export function previewText(t: Thread<MessageLike>): string {
  const latest = t.items[0];
  return latest ? messageLine(latest, t.isGroup).replace(/\s+/g, " ").trim() : "";
}

/**
 * Which chats are expanded to every message. The card is rebuilt on every
 * poll, so this outlives it; chats no longer on the card are dropped.
 */
export class ExpandedSet<K> {
  private keys = new Set<K>();

  has(key: K): boolean {
    return this.keys.has(key);
  }

  /** Flips one chat; returns whether it is now expanded. */
  toggle(key: K): boolean {
    if (this.keys.delete(key)) return false;
    this.keys.add(key);
    return true;
  }

  /** Forgets chats that left the card (opened, read, cleared, pushed out). */
  keepOnly(live: Iterable<K>) {
    const keep = new Set(live);
    for (const k of this.keys) if (!keep.has(k)) this.keys.delete(k);
  }

  get size(): number {
    return this.keys.size;
  }
}
