// Timing for the Music card: where the song is now, which lyric line is
// being sung, how to print a time. Pure (no DOM) so node --test covers it.

export interface LyricLine {
  /** Milliseconds from the start of the song. */
  t: number;
  text: string;
}

/** What `media_lyrics` returns (lyrics.rs). */
export interface Lyrics {
  /** The LRCLIB record these come from. */
  id: number | null;
  synced: LyricLine[];
  plain: string | null;
  instrumental: boolean;
  /** Picked by hand in the search, remembered for this song. */
  chosen: boolean;
}

export interface Timeline {
  playing: boolean;
  /** 0 = the player does not say. */
  durationMs: number;
  /** Where the song was at `positionAtMs` (unix ms). */
  positionMs: number;
  positionAtMs: number;
}

/**
 * A line lights up this early. The poll, the player's own report and the
 * eye all lag a little; a line that appears as it is sung reads as late.
 */
export const LYRIC_LEAD_MS = 200;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function timelineOf(d: Record<string, unknown>): Timeline {
  return {
    playing: d.playing === true,
    durationMs: Math.max(0, num(d.durationMs)),
    positionMs: Math.max(0, num(d.positionMs)),
    positionAtMs: num(d.positionAtMs),
  };
}

/** The song's position now: carried forward while playing, never past its end. */
export function currentPositionMs(t: Timeline, nowMs: number): number {
  let pos = t.positionMs;
  if (t.playing && t.positionAtMs > 0) pos += Math.max(0, nowMs - t.positionAtMs);
  return t.durationMs > 0 ? Math.min(pos, t.durationMs) : pos;
}

/** 0..1 through the song; 0 when the length is unknown. */
export function progress(t: Timeline, nowMs: number): number {
  return t.durationMs > 0 ? currentPositionMs(t, nowMs) / t.durationMs : 0;
}

/** Index of the line being sung at `ms`, -1 before the first one. Lines are sorted. */
export function activeLine(lines: readonly LyricLine[], ms: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** "0:42", "12:05", "1:02:03". */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** One song, whatever its position: lyrics and covers are kept per key. */
export function trackKey(d: Record<string, unknown>): string {
  return [str(d.app), str(d.title), str(d.artist), str(d.album), Math.round(num(d.durationMs) / 1000)].join("\u001f");
}

/** "ILLIT · SUPER REAL ME"; either half may be missing. */
export function subtitle(d: Record<string, unknown>): string {
  return [str(d.artist), str(d.album)].filter((s) => s.trim() !== "").join(" · ");
}

/** The lines the card shows: the one being sung, with the one before and after. */
export function lyricWindow(
  lines: readonly LyricLine[],
  ms: number,
): { index: number; prev: string; current: string; next: string } {
  const index = activeLine(lines, ms + LYRIC_LEAD_MS);
  const textAt = (i: number) => (i >= 0 && i < lines.length ? lines[i].text : "");
  // Before the first line the intro plays: the first line waits underneath.
  return { index, prev: textAt(index - 1), current: index < 0 ? "" : textAt(index), next: textAt(index + 1) };
}

/**
 * The one line the collapsed island shows while music plays: the line being
 * sung, else (intro, a gap, no synced lyrics) the song itself.
 */
export function stripText(d: Record<string, unknown>, lines: readonly LyricLine[], ms: number): string {
  const w = lyricWindow(lines, ms);
  if (w.current.trim() !== "") return w.current;
  return [str(d.title), str(d.artist)].filter((s) => s.trim() !== "").join(" · ");
}

/** Plain lyrics as display lines, blank runs squeezed to one gap. */
export function plainLines(plain: string | null): string[] {
  if (!plain) return [];
  const out: string[] = [];
  for (const raw of plain.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** One row of the manual search (`lyrics_search`, lyrics.rs `Hit`). */
export interface LyricHit {
  id: number;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  synced: boolean;
  plain: boolean;
  instrumental: boolean;
}

/** Same thresholds as lyrics.rs: ≤ 2 s is this recording, ≤ 3 s still fits. */
export type DurationMatch = "same" | "near" | "off" | "unknown";

export function durationMatch(hitMs: number | null, songMs: number): DurationMatch {
  if (hitMs == null || !(hitMs > 0) || !(songMs > 0)) return "unknown";
  const off = Math.abs(hitMs - songMs);
  return off <= 2_000 ? "same" : off <= 3_000 ? "near" : "off";
}

/** What the manual search starts with: the title and the first artist. */
export function defaultQuery(d: Record<string, unknown>): string {
  const artist = str(d.artist).split(/,|;|\/| & | feat\.? | ft\. /i)[0].trim();
  return [str(d.title).trim(), artist].filter(Boolean).join(" ");
}

/** "synced", "plain", "instrumental" or "" for a search row. */
export function hitKind(hit: LyricHit): string {
  return hit.synced ? "synced" : hit.plain ? "plain" : hit.instrumental ? "instrumental" : "";
}
