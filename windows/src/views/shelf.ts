// Shelf and Audio card logic with no DOM, so node --test covers it: which
// tab opens, how old a file reads, when a press turns into a drag, what the
// collapsed island's mic badge says, and when the Audio card must rebuild.

// ── Shelf ─────────────────────────────────────────────────────────────────────

export interface ShelfItem {
  path: string;
  name: string;
  size: number;
  /** Unix ms. */
  modified: number;
  kind: string;
}

export type ShelfTab = "pinned" | "screenshots" | "downloads";

export const SHELF_TABS: readonly ShelfTab[] = ["pinned", "screenshots", "downloads"];

export const SHELF_TAB_LABELS: Record<ShelfTab, string> = {
  pinned: "Shelf",
  screenshots: "Screenshots",
  downloads: "Downloads",
};

/** A press that moves this far is a drag out, not a click. */
export const DRAG_START_PX = 5;

function items(v: unknown): ShelfItem[] {
  return Array.isArray(v) ? (v as ShelfItem[]).filter((i) => i && typeof i.path === "string") : [];
}

export function shelfItems(data: Record<string, unknown>, tab: ShelfTab): ShelfItem[] {
  return items(data[tab]);
}

export function shelfCounts(data: Record<string, unknown>): Record<ShelfTab, number> {
  return { pinned: items(data.pinned).length, screenshots: items(data.screenshots).length, downloads: items(data.downloads).length };
}

/** The tab to open on: what the user kept, else the newest screenshot or download. */
export function defaultTab(data: Record<string, unknown>): ShelfTab {
  if (items(data.pinned).length) return "pinned";
  const shot = items(data.screenshots)[0]?.modified ?? 0;
  const down = items(data.downloads)[0]?.modified ?? 0;
  if (shot === 0 && down === 0) return "pinned";
  return down > shot ? "downloads" : "screenshots";
}

/** "now", "5m", "2h", "3d". */
export function ageLabel(modified: number, nowMs: number): string {
  const s = Math.max(0, (nowMs - modified) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** "820 B", "14 KB", "3.2 MB", "1.4 GB". */
export function sizeLabel(bytes: number): string {
  if (!(bytes >= 0)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export const KIND_COLORS: Record<string, string> = {
  image: "#22C55E",
  video: "#F472B6",
  audio: "#A78BFA",
  doc: "#60A5FA",
  archive: "#F5A524",
  app: "#F4505E",
  code: "#34D399",
  folder: "#FBBF24",
  other: "#8E939C",
};

export function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? KIND_COLORS.other;
}

/** Whether a press moved far enough to be a drag. */
export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_START_PX;
}

// ── Audio ─────────────────────────────────────────────────────────────────────

/** 24×24 stroke paths. */
export const MIC_ICON = "M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3zM6.5 11a5.5 5.5 0 0 0 11 0M12 16.5v4M9 20.5h6";
export const MIC_OFF_ICON = MIC_ICON + "M4.5 4.5l15 15";
export const SPEAKER_ICON = "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11";
export const SPEAKER_OFF_ICON = "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5";

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AudioLevel {
  volume: number;
  muted: boolean;
}

function level(v: unknown): AudioLevel | null {
  const l = v as AudioLevel | null;
  return l && typeof l.volume === "number" ? { volume: l.volume, muted: l.muted === true } : null;
}

export function audioLevel(data: Record<string, unknown>, flow: "output" | "input"): AudioLevel | null {
  return level(data[flow]);
}

export function micUsers(data: Record<string, unknown>): string[] {
  return Array.isArray(data.micUsers) ? (data.micUsers as unknown[]).filter((x): x is string => typeof x === "string") : [];
}

/**
 * The collapsed island's mic badge: "live" while an app records and the mic
 * is on, "muted" while an app records into a muted mic, nothing otherwise.
 */
export function micBadge(data: Record<string, unknown> | null | undefined): "live" | "muted" | null {
  if (!data || micUsers(data).length === 0) return null;
  return audioLevel(data, "input")?.muted ? "muted" : "live";
}

/** "Discord", "Discord and Zoom", "Discord and 2 more". */
export function micUsersLabel(users: readonly string[]): string {
  if (users.length === 0) return "";
  if (users.length === 1) return users[0];
  if (users.length === 2) return `${users[0]} and ${users[1]}`;
  return `${users[0]} and ${users.length - 1} more`;
}

/** "Speakers (Realtek(R) Audio)" → ["Speakers", "Realtek(R) Audio"]. */
export function splitDeviceName(name: string): [string, string] {
  const i = name.indexOf(" (");
  if (i <= 0 || !name.endsWith(")")) return [name, ""];
  return [name.slice(0, i), name.slice(i + 2, -1)];
}

/** 0..1 → "62". */
export function volumePct(v: number): string {
  return String(Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 100));
}

/**
 * What the Audio card is built from. Volumes are left out: they are patched
 * in place, so dragging a slider (which changes the volume) never rebuilds
 * the card under the pointer.
 */
export function audioCardKey(data: Record<string, unknown>): string {
  const strip = (v: unknown) => (Array.isArray(v) ? (v as AudioDevice[]).map((d) => [d.id, d.name, d.isDefault]) : []);
  return JSON.stringify([
    strip(data.outputs),
    strip(data.inputs),
    micUsers(data),
    audioLevel(data, "output")?.muted ?? null,
    audioLevel(data, "input")?.muted ?? null,
    audioLevel(data, "output") != null,
    audioLevel(data, "input") != null,
  ]);
}
