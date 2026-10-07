// Cards for this build's own pills: Claude usage, Space, music, messages.
// Kept out of integrations.ts so the stock cards stay as upstream ships them.

import { h, svg, dot, clear } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { COMPACT_LYRIC_MAX_W, COMPACT_LYRIC_W } from "../core/layout";
import { Bridge } from "../core/bridge";
import { arr, get, header, listRow, timeAgo } from "./integrations";
import { sortSpaceItems } from "./spaceTasks";
import { ExpandedMessages, groupByApp, needsExpander, type MessageGroup } from "./messageGroups";
import {
  MIC_ICON, MIC_OFF_ICON, SHELF_TABS, SHELF_TAB_LABELS, SPEAKER_ICON, SPEAKER_OFF_ICON, ageLabel, audioCardKey,
  audioLevel, defaultTab, isDrag, kindColor, micBadge, micUsers, micUsersLabel, shelfCounts, shelfItems, sizeLabel,
  splitDeviceName, volumePct, type AudioDevice, type ShelfItem, type ShelfTab,
} from "./shelf";
import {
  canRomanize, currentPositionMs, defaultQuery, displayLines, displayPlain, durationMatch, formatTime, hitKind,
  lyricWindow, plainLines, progress, romanLabel,
  stripIslandWidth, stripText, timelineOf, trackKey,
  type LyricHit, type LyricLine, type Lyrics, type Timeline,
} from "./lyrics";

export const PERSONAL_IDS = new Set([
  "integration_quota", "integration_space", "integration_media", "integration_messages",
  "integration_shelf", "integration_audio",
]);

/** Brand colours of the apps the Messages pill reads. */
const APP_COLORS: Record<string, string> = {
  discord: "#5865F2", slack: "#E01E5A", telegram: "#26A5E4", whatsapp: "#25D366",
};
const APP_NAMES: Record<string, string> = {
  discord: "Discord", slack: "Slack", telegram: "Telegram", whatsapp: "WhatsApp",
};

/** 24×24 paths, filled, in the style of icons.ts. */
const MEDIA_ICONS = {
  play: "M7 4.5v15l12.5-7.5L7 4.5z",
  pause: "M6.5 4.5h4v15h-4v-15zm7 0h4v15h-4v-15z",
  next: "M5 4.5v15l10-7.5L5 4.5zm11 0h3v15h-3v-15z",
  prev: "M19 4.5v15L9 12l10-7.5zM5 4.5h3v15H5v-15z",
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** "2h 05m" / "3d" until a reset given in unix seconds. */
export function untilReset(resetsAtSec: number, nowMs = Date.now()): string {
  const s = Math.max(0, resetsAtSec - nowMs / 1000);
  const d = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

function levelColor(pct: number): string {
  return pct >= 90 ? "#F4505E" : pct >= 70 ? "#F5A524" : "#22C55E";
}

// ── Claude usage ──────────────────────────────────────────────────────────────

function gaugeRow(label: string, limit: unknown): HTMLElement | null {
  const l = limit as { pct?: unknown; resetsAt?: unknown } | null;
  const pct = num(l?.pct);
  if (pct == null) return null;
  const fill = h("i");
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  fill.style.background = levelColor(pct);
  const reset = num(l?.resetsAt);
  return h(
    "div",
    { class: "gauge-row" },
    h("span", { class: "gauge-label", text: label }),
    h("span", { class: "gauge" }, fill),
    h("span", { class: "gauge-pct", text: `${Math.round(pct)}%` }),
    h("span", { class: "int-ago", text: reset != null ? `↻ ${untilReset(reset)}` : "" }),
  );
}

function quotaCard(): HTMLElement {
  const d = get("integration_quota");
  const sessions = Array.isArray(d.sessions) ? d.sessions : [];
  const total = num(d.totalCost) ?? 0;
  const extra = h("span", { class: "int-total" }, h("span", { text: `$${total.toFixed(2)}` }));
  const rows = h("div", { class: "int-rows" });
  for (const r of [gaugeRow("5h", d.fiveHour), gaugeRow("7d", d.sevenDay)]) if (r) rows.append(r);
  rows.append(
    h("div", {
      class: "int-status",
      text: `${sessions.length} session${sessions.length === 1 ? "" : "s"} reporting`,
    }),
  );
  return h("div", { class: "int-card" }, header("#E07B53", "Claude", "Usage", extra), rows);
}

// ── Space ─────────────────────────────────────────────────────────────────────

function spaceAccent(item: Record<string, unknown>): string {
  if (item.done === true) return "#22C55E";
  return (num(item.point) ?? 0) === 0 ? "#F4505E" : "#F5A524";
}

function spaceRow(item: Record<string, unknown>, first: boolean): HTMLElement {
  const kind = str(item.kind) === "timebox" ? "TB" : "SP";
  const row = listRow(
    spaceAccent(item),
    first,
    h("span", { class: "int-name", text: str(item.name) || "Untitled" }),
    h("span", { class: "int-ago", text: `${kind} · ${num(item.point) ?? 0} pt` }),
  );
  if (item.done === true) {
    row.classList.add("done");
    row.append(h("span", { class: "space-check", title: "Done" }, svg(ICONS.check, 11, { stroke: 2.6 })));
  }
  return row;
}

/** The card is rebuilt on every Space refresh: keep the list where the user left it. */
let spaceScrollTop = 0;

function spaceCard(onDetail: () => void): HTMLElement {
  const d = get("integration_space");
  const items = sortSpaceItems(arr("integration_space", "items"));
  const total = num(d.totalPoint) ?? 0;
  const done = num(d.totalDone) ?? 0;
  const extra = h(
    "span",
    { class: "int-total", style: total === 8 ? "" : "color:#F5A524" },
    h("span", { text: `${done}/${total} pt` }),
  );
  const rows = h("div", { class: "int-rows" });
  const warnings = Array.isArray(d.warnings) ? (d.warnings as unknown[]).map(str).filter(Boolean) : [];
  if (items.length) {
    const list = h("div", { class: warnings.length ? "int-rows space-list short" : "int-rows space-list" });
    items.forEach((it, i) => list.append(spaceRow(it, i === 0)));
    list.addEventListener("scroll", () => {
      spaceScrollTop = list.scrollTop;
    }, { passive: true });
    // Not in the DOM yet: restore once it is laid out.
    requestAnimationFrame(() => {
      list.scrollTop = spaceScrollTop;
    });
    rows.append(list);
  }
  if (warnings.length) {
    rows.append(h("div", { class: "int-status", style: "color:#F5A524", text: warnings[0] }));
  }
  if (items.length === 0) rows.append(h("div", { class: "int-status", text: "Nothing scheduled today." }));
  const more = h("button", { class: "int-more", title: "All tasks", onclick: onDetail }, svg(ICONS.ellipsis, 8));
  const right = h("span", { class: "int-head-right" }, extra, more);
  return h("div", { class: "int-card" }, header("#4F8EF7", "Space", str(d.date) || "Today", right), rows);
}

function spaceDetail(onBack: () => void): HTMLElement {
  const items = sortSpaceItems(arr("integration_space", "items"));
  const list = h("div", { class: "int-rows scroll space-detail" });
  items.forEach((it, i) => list.append(spaceRow(it, i === 0)));
  return detailFrame("#4F8EF7", "Space · today", onBack, list);
}

// ── Music ─────────────────────────────────────────────────────────────────────

// The card is rebuilt only when the poll's data changes (a new song, play ↔
// pause, a seek). Between rebuilds a 250 ms timer moves the progress bar and
// the lyrics in place, and only while the island is open on a playing song.
// The cover and the lyrics arrive after the card is built and patch it.

const MUSIC_GREEN = "#1DB954";
/** Songs whose lyrics are kept for this run (lyrics.rs caches too). */
const LYRICS_KEPT = 40;
/** A failed lyrics request is tried again on a later card after this long. */
const LYRICS_RETRY_MS = 30_000;
const TICK_MS = 250;

type LyricsState =
  | { status: "loading" }
  | { status: "done"; lyrics: Lyrics | null }
  | { status: "error"; at: number };

const lyricsByTrack = new Map<string, LyricsState>();
/** The cover snapshot() read last; `id` is the poll's `artId`. */
let cover: { id: number; url: string } | null = null;
let coverLoading = 0;

/** What the timer repaints: the card on screen, compact or detail. */
interface LiveMedia {
  key: string;
  root: HTMLElement;
  timeline: Timeline;
  lyricsOn: boolean;
  fill: HTMLElement | null;
  elapsed: HTMLElement | null;
  total: HTMLElement | null;
  art: HTMLElement | null;
  glow: HTMLElement | null;
  /** Card: the line being sung, with the one before and after. */
  lyricBox: HTMLElement | null;
  prev: HTMLElement | null;
  current: HTMLElement | null;
  next: HTMLElement | null;
  /** Detail: every line. */
  list: HTMLElement | null;
  lineEls: HTMLElement[];
  index: number;
  /** The user scrolled the detail list: leave it there for a moment. */
  userScrollAt: number;
  /** The Aa toggle, shown once the lyrics turn out to have a romanization. */
  romanBtn: HTMLElement | null;
}

let live: LiveMedia | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const LYRICS_ICON = "M5 7h14M5 12h14M5 17h8";
const SEARCH_ICON = "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20";
const NOTE_ICON = "M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm10-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z";

function lyricsOn(): boolean {
  return State.settings.lyricsEnabled !== false;
}

function lyricsFor(key: string): LyricsState | undefined {
  return lyricsByTrack.get(key);
}

function ensureLyrics(d: Record<string, unknown>, key: string) {
  if (!lyricsOn() || str(d.title) === "") return;
  const known = lyricsByTrack.get(key);
  if (known && !(known.status === "error" && Date.now() - known.at > LYRICS_RETRY_MS)) return;
  lyricsByTrack.set(key, { status: "loading" });
  while (lyricsByTrack.size > LYRICS_KEPT) {
    const oldest = lyricsByTrack.keys().next().value;
    if (oldest === undefined) break;
    lyricsByTrack.delete(oldest);
  }
  const duration = num(d.durationMs);
  Bridge.mediaLyrics(str(d.title), str(d.artist), str(d.album), duration && duration > 0 ? duration : null)
    .then((lyrics) => lyricsByTrack.set(key, { status: "done", lyrics }))
    .catch(() => lyricsByTrack.set(key, { status: "error", at: Date.now() }))
    .finally(() => {
      if (live?.key === key) renderLyrics(live);
      paintStrip(Date.now());
    });
}

function ensureCover(d: Record<string, unknown>) {
  const id = num(d.artId) ?? 0;
  if (id === 0 || cover?.id === id || coverLoading === id) return;
  coverLoading = id;
  void Bridge.mediaArt().then((art) => {
    coverLoading = 0;
    if (!art) return;
    cover = art;
    if (live) paintCover(live);
  });
}

function paintCover(l: LiveMedia) {
  const d = get("integration_media");
  const url = cover && cover.id === num(d.artId) ? cover.url : null;
  if (l.art) {
    clear(l.art);
    if (url) {
      l.art.append(h("img", { src: url, alt: "", draggable: "false" }));
      l.art.classList.remove("empty");
    } else {
      l.art.append(svg(NOTE_ICON, 22, { stroke: 1.8 }));
      l.art.classList.add("empty");
    }
  }
  if (l.glow) l.glow.style.backgroundImage = url ? `url("${url}")` : "";
}

/** The status line shown in place of lyrics, or null when there are lines to sing. */
function lyricsStatus(key: string): string | null {
  if (!lyricsOn()) return null;
  const s = lyricsFor(key);
  if (!s || s.status === "loading") return "Looking for lyrics…";
  if (s.status === "error") return "Lyrics unavailable right now";
  const l = s.lyrics;
  if (!l || (l.synced.length === 0 && !l.plain && !l.instrumental)) return "No lyrics on LRCLIB";
  if (l.synced.length === 0 && l.instrumental) return "♪  Instrumental";
  if (l.synced.length === 0) return "Lyrics not synced · open ≡ to read";
  return null;
}

function lyricsOf(key: string): Lyrics | null {
  const s = lyricsFor(key);
  return s?.status === "done" ? s.lyrics : null;
}

/** The lines on show: romanized while the Aa toggle is on and the song has them. */
function syncedLines(key: string): LyricLine[] {
  return displayLines(lyricsOf(key), romanOn());
}

function romanOn(): boolean {
  return State.settings.lyricsRomanized === true;
}

/** Flips original ⇄ romanized everywhere at once and remembers it. */
function toggleRoman() {
  State.settings.lyricsRomanized = !romanOn();
  void Bridge.saveSettings(State.settings);
  if (live) renderLyrics(live);
  // The strip only repaints on a new line: make this one new.
  stripLine.textContent = "";
  paintStrip(Date.now());
}

function romanButton(): HTMLElement {
  const b = h("button", {
    class: "int-more roman-btn",
    text: "Aa",
    onclick: (e: Event) => {
      e.stopPropagation();
      toggleRoman();
    },
  });
  b.style.display = "none";
  return b;
}

/** Shows the toggle when the song has a romanization, lit while it is on. */
function syncRomanButton(l: LiveMedia) {
  const b = l.romanBtn;
  if (!b) return;
  const lyrics = lyricsOf(l.key);
  const shown = lyricsOn() && canRomanize(lyrics);
  b.style.display = shown ? "" : "none";
  b.classList.toggle("on", shown && romanOn());
  const label = romanLabel(lyrics?.lang);
  b.title = romanOn() ? "Show the original lyrics" : `Show ${label}`;
}

/** Rebuilds the lyric part of the live card after the lyrics arrive or the preference flips. */
function renderLyrics(l: LiveMedia) {
  l.lyricsOn = lyricsOn();
  l.index = -2; // force the next paint
  if (l.lyricBox) {
    l.lyricBox.style.display = l.lyricsOn ? "" : "none";
    l.root.classList.toggle("no-lyrics", !l.lyricsOn);
  }
  if (l.list) fillLyricList(l);
  syncRomanButton(l);
  paint(l, Date.now());
}

function setLine(el: HTMLElement | null, text: string, animate: boolean) {
  if (!el) return;
  const shown = text.trim() === "" ? "♪" : text;
  if (el.textContent === shown) return;
  el.textContent = shown;
  el.classList.toggle("rest", shown === "♪");
  if (animate) {
    el.classList.remove("enter");
    void el.offsetWidth; // restart the animation
    el.classList.add("enter");
  }
}

function paint(l: LiveMedia, nowMs: number) {
  const t = l.timeline;
  const pos = currentPositionMs(t, nowMs);
  if (l.fill) l.fill.style.transform = `scaleX(${progress(t, nowMs).toFixed(4)})`;
  if (l.elapsed) l.elapsed.textContent = formatTime(pos);
  if (l.total) l.total.textContent = t.durationMs > 0 ? formatTime(t.durationMs) : "";

  if (!l.lyricsOn) return;
  const status = lyricsStatus(l.key);
  const lines = syncedLines(l.key);
  if (l.prev && l.current && l.next) {
    if (status != null) {
      l.prev.textContent = "";
      l.current.textContent = status;
      l.current.classList.add("status");
      l.current.classList.remove("rest", "enter");
      l.next.textContent = "";
    } else {
      l.current.classList.remove("status");
      const w = lyricWindow(lines, pos);
      if (w.index !== l.index) {
        const first = l.index === -2;
        l.index = w.index;
        // Before the first line: the intro, with the first line waiting below.
        l.prev.textContent = w.prev;
        setLine(l.current, w.index < 0 ? "" : w.current, !first);
        l.next.textContent = w.next;
        if (!first) {
          for (const el of [l.prev, l.next]) {
            el.classList.remove("enter");
            void el.offsetWidth; // restart the animation
            el.classList.add("enter");
          }
        }
      }
    }
  }
  if (l.list && lines.length) {
    const index = lyricWindow(lines, pos).index;
    if (index !== l.index) {
      const first = l.index === -2;
      l.index = index;
      l.lineEls.forEach((el, i) => {
        el.classList.toggle("on", i === index);
        el.classList.toggle("past", i < index);
      });
      const el = l.lineEls[index];
      if (el && nowMs - l.userScrollAt > 4_000) {
        const top = el.offsetTop - l.list.clientHeight / 2 + el.offsetHeight / 2;
        l.list.scrollTo({ top: Math.max(0, top), behavior: first ? "auto" : "smooth" });
      }
    }
  }
}

function cardMoving(): boolean {
  const l = live;
  return l != null && l.root.isConnected && State.mode === "expanded" && l.timeline.playing;
}

function stripMoving(): boolean {
  return State.mode === "compact" && lyricStripActive();
}

function tick() {
  const card = cardMoving();
  const strip = stripMoving();
  if (!card && !strip) {
    stopTimer();
    return;
  }
  const now = Date.now();
  if (card && live) paint(live, now);
  if (strip) paintStrip(now);
}

function stopTimer() {
  if (timer != null) clearInterval(timer);
  timer = null;
}

/** Runs the timer exactly while there is something moving on screen. */
function syncTimer() {
  const strip = stripMoving();
  if (strip) {
    // The island may collapse before the card was ever built.
    const d = get("integration_media");
    ensureLyrics(d, trackKey(d));
  }
  const wanted = cardMoving() || strip;
  if (wanted && timer == null) {
    timer = setInterval(tick, TICK_MS);
    tick();
  } else if (!wanted) {
    stopTimer();
  }
}

// ── Collapsed island: the line being sung ─────────────────────────────────────

const stripLine = h("div", { class: "lyric-strip-line" });
const strip = h("div", { id: "lyric-strip" }, stripLine);

/** The strip island.ts lays over the collapsed island in place of the mini bots. */
export function lyricStripEl(): HTMLElement {
  return strip;
}

/** How wide the collapsed island wants to be for the line on show. */
let stripWidth = COMPACT_LYRIC_W;
let onStripResize: () => void = () => {};
let measureCtx: CanvasRenderingContext2D | null = null;

export function lyricStripWidth(): number {
  return stripWidth;
}

/** island.ts resizes the collapsed island when a line needs another width. */
export function onLyricStripResize(fn: () => void) {
  onStripResize = fn;
}

/** The line's width in the strip's own font, without laying anything out. */
function measureLine(text: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = getComputedStyle(stripLine).font || "600 12px sans-serif";
  return measureCtx.measureText(text).width;
}

/** True while the collapsed island should sing: the Music pill has the focus and a song plays. */
export function lyricStripActive(): boolean {
  if (State.focusTask?.id !== "integration_media" || !hasPersonalData("integration_media")) return false;
  return get("integration_media").playing === true;
}

function paintStrip(nowMs: number) {
  if (!lyricStripActive()) return;
  const d = get("integration_media");
  const lines = lyricsOn() ? syncedLines(trackKey(d)) : [];
  const text = stripText(d, lines, currentPositionMs(timelineOf(d), nowMs));
  if (stripLine.textContent === text) return;
  stripLine.textContent = text;
  stripLine.title = text;
  const width = stripIslandWidth(measureLine(text), COMPACT_LYRIC_W, COMPACT_LYRIC_MAX_W);
  if (width !== stripWidth) {
    stripWidth = width;
    onStripResize();
  }
  stripLine.classList.remove("enter");
  void stripLine.offsetWidth; // restart the animation
  stripLine.classList.add("enter");
}

// Opening the island or flipping the Lyrics preference reaches the card
// without a rebuild: catch both here.
State.subscribe(() => {
  if (live && live.lyricsOn !== lyricsOn()) {
    if (lyricsOn()) ensureLyrics(get("integration_media"), live.key);
    renderLyrics(live);
  }
  syncTimer();
});

function goLive(l: LiveMedia) {
  live = l;
  paintCover(l);
  // Laid out once it is in the DOM: paint then, so the bar starts right.
  requestAnimationFrame(() => {
    if (live !== l) return;
    renderLyrics(l);
    syncTimer();
  });
}

function emptyLive(key: string, root: HTMLElement, timeline: Timeline): LiveMedia {
  return {
    key, root, timeline, lyricsOn: lyricsOn(),
    fill: null, elapsed: null, total: null, art: null, glow: null,
    lyricBox: null, prev: null, current: null, next: null,
    list: null, lineEls: [], index: -2, userScrollAt: 0, romanBtn: null,
  };
}

function mediaButtons(d: Record<string, unknown>): HTMLElement {
  const playing = d.playing === true;
  // Paths, not ⏮ ⏯ ⏭: Windows draws those as coloured emoji tiles.
  const button = (path: string, title: string, action: string, enabled: boolean, cls = "") => {
    const b = h(
      "button",
      {
        class: `media-btn ${cls}`.trim(),
        title,
        onclick: (e: Event) => {
          e.stopPropagation();
          if (enabled) void Bridge.mediaControl(action);
        },
      },
      svg(path, cls ? 11 : 10),
    );
    if (!enabled) b.classList.add("off");
    return b;
  };
  return h(
    "div",
    { class: "media-controls" },
    button(MEDIA_ICONS.prev, "Previous", "prev", d.canPrev === true),
    button(playing ? MEDIA_ICONS.pause : MEDIA_ICONS.play, playing ? "Pause" : "Play", "play_pause", d.canPlayPause !== false, "main"),
    button(MEDIA_ICONS.next, "Next", "next", d.canNext === true),
  );
}

function mediaCard(onDetail: () => void): HTMLElement {
  const d = get("integration_media");
  const key = trackKey(d);
  const timeline = timelineOf(d);
  ensureLyrics(d, key);
  ensureCover(d);

  const art = h("div", { class: "media-art empty" });
  const glow = h("div", { class: "media-glow" });
  const fill = h("i");
  const elapsed = h("span", { class: "media-time" });
  const total = h("span", { class: "media-time end" });
  const prev = h("div", { class: "media-line side" });
  const current = h("div", { class: "media-line" });
  const next = h("div", { class: "media-line side" });
  const lyricBox = h("div", { class: "media-lyrics" }, prev, current, next);

  const lyricsBtn = h("button", { class: "int-more", title: "Lyrics", onclick: onDetail }, svg(LYRICS_ICON, 9, { stroke: 2.4 }));
  const romanBtn = romanButton();
  const right = h("span", { class: "int-head-right" }, romanBtn, lyricsOn() ? lyricsBtn : null);
  const title = str(d.title);
  const artist = str(d.artist);
  const names = artist ? `${title} · ${artist}` : title;

  const root = h(
    "div",
    { class: timeline.playing ? "int-card media-card playing" : "int-card media-card" },
    glow,
    header(MUSIC_GREEN, "Music", str(d.app) || "Now playing", right),
    // Two columns: the song (cover, names, controls, progress) on the left,
    // the lyrics on the right. The album stays off the card.
    h(
      "div",
      { class: "media-main" },
      h(
        "div",
        { class: "media-left" },
        h(
          "div",
          { class: "media-row" },
          art,
          h(
            "div",
            { class: "media-info", title: names },
            h("div", { class: "media-title", text: title }),
            artist ? h("div", { class: "media-artist", text: artist }) : null,
            mediaButtons(d),
          ),
        ),
        h("div", { class: "media-progress" }, elapsed, h("div", { class: "media-bar" }, fill), total),
      ),
      h("div", { class: "media-divider" }),
      lyricBox,
    ),
  );
  // Clicking the lyrics opens them all.
  lyricBox.addEventListener("click", () => {
    if (lyricsOn()) onDetail();
  });

  const l = emptyLive(key, root, timeline);
  Object.assign(l, { fill, elapsed, total, art, glow, lyricBox, prev, current, next, romanBtn });
  goLive(l);
  return root;
}

function fillLyricList(l: LiveMedia) {
  if (!l.list) return;
  clear(l.list);
  l.lineEls = [];
  const status = lyricsStatus(l.key);
  const lyrics = lyricsOf(l.key);
  if (!lyricsOn()) {
    l.list.append(h("div", { class: "int-status", text: "Lyrics are off (Settings → Music)." }));
    return;
  }
  const plain = displayPlain(lyrics, romanOn());
  if (lyrics && lyrics.synced.length) {
    for (const line of displayLines(lyrics, romanOn())) {
      const el = h("div", { class: line.text.trim() ? "lyr-line" : "lyr-line rest", text: line.text.trim() || "♪" });
      l.lineEls.push(el);
      l.list.append(el);
    }
  } else if (lyrics && plain) {
    l.list.append(h("div", { class: "int-status", text: "Not synced with the song." }));
    for (const line of plainLines(plain)) {
      l.list.append(h("div", { class: line ? "lyr-line plain" : "lyr-gap", text: line }));
    }
  } else {
    l.list.append(h("div", { class: "int-status", text: status ?? "No lyrics on LRCLIB" }));
  }
  if (!lyrics || lyrics.synced.length === 0) {
    l.list.append(
      h("button", { class: "lyr-btn find", text: "Search lyrics by hand", onclick: () => openSearch() }),
    );
  }
  const credit = lyrics?.chosen ? "Lyrics from lrclib.net · picked by you" : "Lyrics from lrclib.net";
  l.list.append(h("div", { class: "lyr-credit", text: credit }));
}

// ── Manual lyrics search ──────────────────────────────────────────────────────
// Opened from the lyrics detail when the match is wrong or missing: LRCLIB's
// free-text search, best rows for this song first; a click uses that record
// for this song from now on (lyrics.rs remembers it).

interface SearchState {
  /** The song the search is for; a new song closes it. */
  key: string;
  query: string;
  status: "idle" | "loading" | "done" | "error";
  hits: LyricHit[];
  error: string;
  /** Row being applied. */
  choosing: number | null;
  /** Survives the card's rebuilds, so typing is not cut off by a poll. */
  focused: boolean;
  caret: number;
  /** Bumped per search: a slow answer to an older query is dropped. */
  seq: number;
}

let search: SearchState | null = null;
/** Rebuilds the card (the hooks' openDetail): set by every media render. */
let rebuild: () => void = () => {};
let searchList: HTMLElement | null = null;

function openSearch() {
  const d = get("integration_media");
  search = {
    key: trackKey(d), query: defaultQuery(d), status: "idle", hits: [], error: "",
    choosing: null, focused: false, caret: 0, seq: 0,
  };
  rebuild();
  runSearch();
}

function closeSearch() {
  if (search?.focused) void Bridge.focusWindow(false);
  search = null;
  searchList = null;
  rebuild();
}

function runSearch() {
  const s = search;
  if (!s) return;
  const seq = ++s.seq;
  s.status = "loading";
  s.error = "";
  renderHits();
  const duration = num(get("integration_media").durationMs);
  Bridge.lyricsSearch(s.query, duration && duration > 0 ? duration : null)
    .then((hits) => {
      if (search !== s || s.seq !== seq) return;
      s.hits = hits;
      s.status = "done";
    })
    .catch((e: unknown) => {
      if (search !== s || s.seq !== seq) return;
      s.status = "error";
      s.error = String(e);
    })
    .finally(renderHits);
}

/** Uses record `id` (null = the automatic match again) for the song the search is for. */
function choose(id: number | null) {
  const s = search;
  if (!s || s.choosing != null) return;
  const d = get("integration_media");
  if (trackKey(d) !== s.key) return closeSearch();
  s.choosing = id ?? -1;
  renderHits();
  const duration = num(d.durationMs);
  Bridge.lyricsChoose(str(d.title), str(d.artist), str(d.album), duration && duration > 0 ? duration : null, id)
    .then((lyrics) => {
      lyricsByTrack.set(s.key, { status: "done", lyrics });
      if (search === s) closeSearch();
    })
    .catch((e: unknown) => {
      if (search !== s) return;
      s.choosing = null;
      s.status = "error";
      s.error = String(e);
      renderHits();
    });
}

const MATCH_COLORS: Record<string, string> = {
  same: "#22C55E", near: "#F5A524", off: "#5f646d", unknown: "#8e939c",
};
const MATCH_TITLES: Record<string, string> = {
  same: "Same length as the song",
  near: "Within 3 s of the song",
  off: "Another length: likely another recording",
  unknown: "Length unknown",
};

function hitRow(hit: LyricHit, songMs: number, currentId: number | null, s: SearchState): HTMLElement {
  const match = durationMatch(hit.durationMs, songMs);
  const kind = hitKind(hit);
  const row = h(
    "div",
    {
      class: "lyr-hit",
      title: [hit.album, MATCH_TITLES[match]].filter(Boolean).join(" · "),
      onclick: () => choose(hit.id),
    },
    dot(MATCH_COLORS[match], 5),
    h(
      "span",
      { class: "lyr-hit-name" },
      h("b", { text: hit.title || "Untitled" }),
      hit.artist ? h("span", { text: ` · ${hit.artist}` }) : null,
      hit.album ? h("i", { text: ` · ${hit.album}` }) : null,
    ),
    h("span", { class: `lyr-hit-time ${match}`, text: hit.durationMs != null ? formatTime(hit.durationMs) : "" }),
    kind ? h("span", { class: `lyr-badge ${kind}`, text: kind }) : null,
  );
  if (hit.id === currentId) {
    row.classList.add("current");
    row.append(h("span", { class: "space-check", title: "Showing now" }, svg(ICONS.check, 10, { stroke: 2.6 })));
  }
  if (s.choosing === hit.id) row.classList.add("busy");
  return row;
}

function renderHits() {
  const s = search;
  const list = searchList;
  if (!s || !list || !list.isConnected) return;
  clear(list);
  const d = get("integration_media");
  const songMs = num(d.durationMs) ?? 0;
  const known = lyricsFor(s.key);
  const currentId = known?.status === "done" ? (known.lyrics?.id ?? null) : null;
  if (s.status === "loading") list.append(h("div", { class: "int-status", text: "Searching lrclib.net…" }));
  if (s.status === "error") list.append(h("div", { class: "int-status", style: "color:#F4505E", text: s.error }));
  if (s.status === "done" && s.hits.length === 0) {
    list.append(h("div", { class: "int-status", text: "Nothing found. Try fewer words or another spelling." }));
  }
  for (const hit of s.hits) list.append(hitRow(hit, songMs, currentId, s));
  if (s.choosing === -1) list.prepend(h("div", { class: "int-status", text: "Going back to the automatic match…" }));
}

function searchPanel(): HTMLElement {
  const s = search!;
  const input = h("input", {
    class: "lyr-input",
    type: "text",
    spellcheck: "false",
    placeholder: "Title and artist",
  }) as HTMLInputElement;
  input.value = s.query;
  input.addEventListener("input", () => {
    s.query = input.value;
    s.caret = input.selectionStart ?? input.value.length;
  });
  // The island never takes the keyboard on its own: ask for it on a click.
  input.addEventListener("mousedown", () => {
    void Bridge.focusWindow(true);
    window.setTimeout(() => input.focus(), 30);
  });
  input.addEventListener("focus", () => {
    s.focused = true;
  });
  input.addEventListener("blur", () => {
    // Removed by a rebuild: the new field takes the focus back.
    if (!input.isConnected || search !== s) return;
    s.focused = false;
    s.caret = input.selectionStart ?? input.value.length;
    void Bridge.focusWindow(false);
  });
  input.addEventListener("keydown", (e) => {
    // ← → move the caret here, not the pills; Escape leaves the search, not the island.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      closeSearch();
    }
  });

  const known = lyricsFor(s.key);
  const chosen = known?.status === "done" && known.lyrics?.chosen === true;
  const list = h("div", { class: "int-rows scroll lyr-hits" });
  searchList = list;
  const panel = h(
    "div",
    { class: "int-card detail media-detail lyr-search" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", title: "Back to the lyrics", onclick: closeSearch }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      input,
      h("button", { class: "lyr-btn", title: "Search (Enter)", onclick: runSearch }, svg(SEARCH_ICON, 10, { stroke: 2.4 })),
      chosen
        ? h("button", { class: "lyr-btn ghost", title: "Forget the pick and match automatically", text: "Auto", onclick: () => choose(null) })
        : null,
    ),
    list,
  );
  // Selecting text must not swipe to another pill (carousel drag).
  panel.addEventListener("mousedown", (e) => e.stopPropagation());
  requestAnimationFrame(() => {
    renderHits();
    if (s.focused && search === s) {
      input.focus();
      input.setSelectionRange(s.caret, s.caret);
    }
  });
  return panel;
}

function mediaDetail(onBack: () => void, onRebuild: () => void): HTMLElement {
  const d = get("integration_media");
  const key = trackKey(d);
  const timeline = timelineOf(d);
  rebuild = onRebuild;
  // A new song ends a search meant for the last one.
  if (search && search.key !== key) {
    if (search.focused) void Bridge.focusWindow(false);
    search = null;
  }
  if (search && lyricsOn()) {
    live = null;
    syncTimer();
    return searchPanel();
  }
  ensureLyrics(d, key);

  const list = h("div", { class: "int-rows scroll lyr-list" });
  const fill = h("i");
  const elapsed = h("span", { class: "media-time" });
  const total = h("span", { class: "media-time end" });
  const frame = detailFrame(MUSIC_GREEN, str(d.title) || "Lyrics", onBack, list);
  frame.classList.add("media-detail");
  const head = frame.querySelector(".int-detail-head");
  const artist = str(d.artist);
  if (head) {
    if (artist) head.append(h("span", { class: "media-detail-artist", text: artist }));
    head.append(h("div", { class: "media-progress mini" }, elapsed, h("div", { class: "media-bar" }, fill), total));
  }
  const romanBtn = romanButton();
  if (head) {
    head.append(romanBtn);
    if (lyricsOn()) {
      head.append(h("button", { class: "int-more", title: "Wrong lyrics? Search by hand", onclick: openSearch }, svg(SEARCH_ICON, 10, { stroke: 2.4 })));
    }
  }

  const l = emptyLive(key, frame, timeline);
  Object.assign(l, { fill, elapsed, total, list, romanBtn });
  list.addEventListener("wheel", () => {
    l.userScrollAt = Date.now();
  }, { passive: true });
  goLive(l);
  return frame;
}

// ── Messages ──────────────────────────────────────────────────────────────────

/** "Server › #channel", "Workspace › #channel", "#channel", or "" for a DM. */
export function messagePlace(m: { place?: unknown; channel?: unknown }): string {
  return [str(m.place), str(m.channel)].filter(Boolean).join(" › ");
}

/** Which messages show their full text; outlives the card's rebuilds. */
const expanded = new ExpandedMessages();

/**
 * One message, laid out like an Android notification under its app's heading:
 * the sender (and where it was sent) on top, the message below. Long or
 * multi-line text is cut to one line, and the chevron expands it.
 */
function messageItem(m: Record<string, unknown>, newest: boolean): HTMLElement {
  const app = str(m.app);
  const place = messagePlace(m);
  const id = num(m.id);
  const text = str(m.text);
  const body = h("span", { class: "msg-text", text });
  const toggle = h("button", { class: "msg-toggle", title: "Show more" }, svg(ICONS.chevronRight, 8, { stroke: 2.4 }));
  const item = h(
    "div",
    { class: "msg-item" },
    h(
      "div",
      { class: "msg-top" },
      h("span", { class: "msg-sender", text: str(m.sender) || APP_NAMES[app] || "Message" }),
      place ? h("span", { class: "msg-place", text: place }) : null,
      h("span", { class: "int-ago", text: timeAgo(num(m.at) ?? Date.now()) }),
    ),
    h("div", { class: "msg-body" }, body, toggle),
  );
  if (newest) {
    item.classList.add("newest");
    item.style.background = `${APP_COLORS[app] ?? "#8e939c"}1f`;
  }
  const isOpen = id != null && expanded.has(id);
  const show = (open: boolean) => {
    item.classList.toggle("expanded", open);
    toggle.title = open ? "Show less" : "Show more";
  };
  show(isOpen);
  // Whether the text is cut off is only known once it is laid out.
  requestAnimationFrame(() => {
    const cut = body.scrollWidth > body.clientWidth + 1;
    toggle.classList.toggle("shown", isOpen || needsExpander(text, cut));
  });
  toggle.addEventListener("click", (e) => {
    e.stopPropagation(); // expanding is not opening
    if (id != null) show(expanded.toggle(id));
  });
  item.title = `${APP_NAMES[app] ?? app}${place ? ` · ${place}` : ""}`;
  item.addEventListener("click", () => openMessages(app, [m]));
  return item;
}

function groupHead(group: MessageGroup<Record<string, unknown>>): HTMLElement {
  const name = APP_NAMES[group.app] ?? (group.app || "Other");
  const head = h(
    "div",
    { class: "msg-group", title: `Open ${name}` },
    dot(APP_COLORS[group.app] ?? "#8e939c", 5),
    h("b", { text: name }),
    h("span", { class: "int-ago", text: String(group.items.length) }),
  );
  head.addEventListener("click", () => openMessages(group.app, group.items));
  return head;
}

/** Opening a message reads it: the app comes forward and the message leaves the card. */
function openMessages(app: string, messages: Record<string, unknown>[]) {
  void Bridge.openApp(app);
  const ids = messages.map((m) => num(m.id)).filter((id): id is number => id != null);
  if (ids.length) void Bridge.dismissMessages(ids);
}

/** The card is rebuilt on every poll: keep the list where the user left it, back to the top for news. */
let msgScrollTop = 0;
let msgNewestId: unknown = null;

function messagesCard(onDetail: () => void): HTMLElement {
  const messages = arr("integration_messages", "messages");
  const more = h("button", { class: "int-more", title: "All messages", onclick: onDetail }, svg(ICONS.ellipsis, 8));
  const clearAll = h("button", {
    class: "int-clear",
    title: "Take every message off the card",
    text: "Clear all",
    onclick: () => void Bridge.dismissMessages(null),
  });
  const right = h("span", { class: "int-head-right" }, clearAll, more);
  const list = h("div", { class: "int-rows msg-list" });
  expanded.keepOnly(messages.map((m) => num(m.id)).filter((id): id is number => id != null));
  for (const g of groupByApp(messages)) {
    list.append(groupHead(g));
    for (const m of g.items) list.append(messageItem(m, m === messages[0]));
  }
  const newestId = messages[0]?.id ?? null;
  if (newestId !== msgNewestId) {
    msgNewestId = newestId;
    msgScrollTop = 0;
  }
  list.addEventListener("scroll", () => {
    msgScrollTop = list.scrollTop;
  }, { passive: true });
  // Not in the DOM yet: restore once it is laid out.
  requestAnimationFrame(() => {
    list.scrollTop = msgScrollTop;
  });
  return h("div", { class: "int-card" }, header("#5865F2", "Messages", `${messages.length} recent`, right), list);
}

function messagesDetail(onBack: () => void): HTMLElement {
  const messages = arr("integration_messages", "messages");
  const list = h("div", { class: "int-rows scroll msg-detail" });
  for (const g of groupByApp(messages)) {
    list.append(groupHead(g));
    g.items.forEach((m) => list.append(messageItem(m, m === messages[0])));
  }
  return detailFrame("#5865F2", "Messages", onBack, list);
}

// ── Shelf ─────────────────────────────────────────────────────────────────────
// Tiles of files: click opens, press and move drags real files out to any app
// (Explorer, Discord, a browser upload), the hover buttons copy, show in
// Explorer or take a kept file off the shelf.

const SHELF_COLOR = "#F5A524";
const COPY_ICON = "M9 9h10v10H9zM5 15V5h10";
const FOLDER_ICON = "M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z";
const REMOVE_ICON = "M7 7l10 10M17 7 7 17";

let shelfTab: ShelfTab | null = null;
const shelfScroll: Record<ShelfTab, number> = { pinned: 0, screenshots: 0, downloads: 0 };
/** Thumbnails by path and modification time; null = the shell had none. */
const thumbCache = new Map<string, string | null>();
const thumbWaiting: Array<() => void> = [];
let thumbsRunning = 0;
let shelfDragging = false;

/** Opens the Shelf card on this tab (a drop shows what was just kept). */
export function showShelfTab(tab: ShelfTab) {
  shelfTab = tab;
  shelfScroll[tab] = 0;
}

/** True while a file dragged out of the shelf is in the air: its drop back on the island is not a new drop. */
export function shelfDragActive(): boolean {
  return shelfDragging;
}

function thumbKey(it: ShelfItem): string {
  return `${it.path}\u001f${it.modified}`;
}

/** Three thumbnails at a time: the shell is slow on the first video or PDF. */
function queueThumb(job: () => Promise<void>) {
  const run = () => {
    thumbsRunning++;
    void job().finally(() => {
      thumbsRunning--;
      thumbWaiting.shift()?.();
    });
  };
  if (thumbsRunning < 3) run();
  else thumbWaiting.push(run);
}

function paintThumb(box: HTMLElement, it: ShelfItem) {
  const key = thumbKey(it);
  const show = (url: string | null | undefined) => {
    clear(box);
    if (url) {
      box.append(h("img", { src: url, alt: "", draggable: "false" }));
      box.classList.remove("glyph");
    } else {
      const ext = it.kind === "folder" ? "DIR" : (it.name.split(".").pop() ?? "").slice(0, 4).toUpperCase();
      box.append(h("span", { text: ext || "FILE" }));
      box.style.setProperty("--kind", kindColor(it.kind));
      box.classList.add("glyph");
    }
  };
  if (thumbCache.has(key)) return show(thumbCache.get(key));
  show(null);
  // The tile is not in the DOM yet: ask once it is laid out.
  requestAnimationFrame(() => queueThumb(async () => {
    if (!box.isConnected) return;
    const url = (await Bridge.shelfThumb(it.path)) ?? null;
    thumbCache.set(key, url);
    if (thumbCache.size > 300) thumbCache.delete(thumbCache.keys().next().value!);
    if (box.isConnected) show(url);
  }));
}

function flash(tile: HTMLElement, text: string) {
  const note = h("div", { class: "shelf-flash", text });
  tile.append(note);
  window.setTimeout(() => note.remove(), 1100);
}

function shelfTile(it: ShelfItem, tab: ShelfTab): HTMLElement {
  const thumb = h("div", { class: "shelf-thumb" });
  paintThumb(thumb, it);
  const action = (icon: string, title: string, run: () => Promise<unknown> | void): HTMLElement =>
    h("button", {
      class: "shelf-act",
      title,
      onclick: (e: Event) => {
        e.stopPropagation();
        void Promise.resolve(run()).catch((err: unknown) => flash(tile, String(err).slice(0, 40)));
      },
    }, svg(icon, 10, { stroke: 2.2 }));
  const actions: HTMLElement = h(
    "div",
    { class: "shelf-acts" },
    action(COPY_ICON, it.kind === "image" ? "Copy (as a picture too)" : "Copy", () => Bridge.shelfCopy(it.path).then(() => flash(tile, "Copied"))),
    action(FOLDER_ICON, "Show in folder", () => Bridge.shelfReveal(it.path)),
    tab === "pinned" ? action(REMOVE_ICON, "Take off the shelf", () => Bridge.shelfUnpin(it.path)) : null,
  );
  const tile: HTMLElement = h(
    "div",
    { class: "shelf-tile", title: `${it.name}\n${sizeLabel(it.size)} · drag it out, click to open` },
    thumb,
    actions,
    h("div", { class: "shelf-name", text: it.name }),
    h("div", { class: "shelf-age", text: ageLabel(it.modified, Date.now()) }),
  );
  tile.addEventListener("mousedown", (e) => {
    // The tile handles its own press: no carousel swipe, no island click.
    e.stopPropagation();
    if (e.button !== 0 || (e.target as HTMLElement).closest(".shelf-act")) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragged = false;
    const move = (ev: MouseEvent) => {
      if (dragged || !isDrag(ev.clientX - x0, ev.clientY - y0)) return;
      dragged = true;
      done();
      shelfDragging = true;
      tile.classList.add("dragging");
      void Bridge.shelfDrag([it.path]).finally(() => {
        shelfDragging = false;
        tile.classList.remove("dragging");
      });
    };
    const up = () => {
      done();
      if (!dragged) void Bridge.shelfOpen(it.path).catch((err: unknown) => flash(tile, String(err).slice(0, 40)));
    };
    const done = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  return tile;
}

const SHELF_EMPTY: Record<ShelfTab, string> = {
  pinned: "Drop files on Mochi to keep them here, ready to drag into any app.",
  screenshots: "No screenshots in the last 3 days.",
  downloads: "No downloads in the last 3 days.",
};

function shelfCard(): HTMLElement {
  const d = get("integration_shelf");
  shelfTab ??= defaultTab(d);
  const counts = shelfCounts(d);
  const row = h("div", { class: "shelf-row" });
  const clearBtn = h("button", {
    class: "int-clear",
    text: "Clear",
    title: "Take everything off the shelf (the files stay where they are)",
    onclick: () => void Bridge.shelfClear(),
  });
  const tabs = h("span", { class: "shelf-tabs" });

  const fill = () => {
    const tab = shelfTab ?? "pinned";
    clear(tabs);
    for (const t of SHELF_TABS) {
      tabs.append(
        h("button", {
          class: t === tab ? "shelf-tab on" : "shelf-tab",
          onclick: () => {
            shelfScroll[tab] = row.scrollLeft;
            shelfTab = t;
            fill();
          },
        }, h("span", { text: SHELF_TAB_LABELS[t] }), counts[t] ? h("i", { text: String(counts[t]) }) : null),
      );
    }
    clearBtn.style.display = tab === "pinned" && counts.pinned > 0 ? "" : "none";
    clear(row);
    const list = shelfItems(d, tab);
    if (list.length === 0) row.append(h("div", { class: "int-status shelf-empty", text: SHELF_EMPTY[tab] }));
    for (const it of list) row.append(shelfTile(it, tab));
    requestAnimationFrame(() => {
      row.scrollLeft = shelfScroll[tab];
    });
  };
  row.addEventListener("scroll", () => {
    shelfScroll[shelfTab ?? "pinned"] = row.scrollLeft;
  }, { passive: true });
  // A mouse wheel scrolls the row sideways, not the pills.
  row.addEventListener("wheel", (e) => {
    e.stopPropagation();
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      row.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  fill();
  const right = h("span", { class: "int-head-right" }, clearBtn);
  const head = header(SHELF_COLOR, "Shelf", "", right);
  head.insertBefore(tabs, right);
  return h("div", { class: "int-card shelf-card" }, head, row);
}

// ── Audio ─────────────────────────────────────────────────────────────────────
// Speaker and microphone rows: the icon mutes, the name opens the device
// list, the slider sets the volume. Volumes are patched in place
// (patchAudioCard) so a slider is never rebuilt under the pointer.

const AUDIO_COLOR = "#A78BFA";

interface AudioRowEls {
  slider: HTMLInputElement;
  pct: HTMLElement;
  dragging: boolean;
}

const audioEls: Partial<Record<"output" | "input", AudioRowEls>> = {};
const volumeTimers: Partial<Record<"output" | "input", number>> = {};

function sendVolume(flow: "output" | "input", value: number) {
  // Trailing throttle: at most one change every 60 ms while dragging.
  if (volumeTimers[flow] != null) window.clearTimeout(volumeTimers[flow]);
  volumeTimers[flow] = window.setTimeout(() => {
    volumeTimers[flow] = undefined;
    void Bridge.audioSetVolume(flow, value);
  }, 60);
}

function audioRow(flow: "output" | "input", onDevices: () => void): HTMLElement {
  const d = get("integration_audio");
  const lvl = audioLevel(d, flow);
  const devices = (Array.isArray(d[flow === "output" ? "outputs" : "inputs"]) ? d[flow === "output" ? "outputs" : "inputs"] : []) as AudioDevice[];
  const current = devices.find((x) => x.isDefault);
  const [name, driver] = splitDeviceName(current?.name ?? (flow === "output" ? "No speakers" : "No microphone"));
  const muted = lvl?.muted === true;
  const icon = flow === "output" ? (muted ? SPEAKER_OFF_ICON : SPEAKER_ICON) : muted ? MIC_OFF_ICON : MIC_ICON;
  const mute = h("button", {
    class: muted ? "audio-mute muted" : "audio-mute",
    title: muted ? "Unmute" : "Mute",
    onclick: () => void Bridge.audioSetMute(flow, !muted),
  }, svg(icon, 13, { stroke: 1.9 }));
  if (!lvl) mute.setAttribute("disabled", "true");
  const slider = h("input", { type: "range", min: "0", max: "100", step: "1", class: "audio-slider" }) as HTMLInputElement;
  slider.value = volumePct(lvl?.volume ?? 0);
  slider.disabled = !lvl;
  const pct = h("span", { class: "audio-pct", text: lvl ? volumePct(lvl.volume) : "" });
  const els: AudioRowEls = { slider, pct, dragging: false };
  audioEls[flow] = els;
  const paintFill = () => slider.style.setProperty("--fill", `${slider.value}%`);
  paintFill();
  slider.addEventListener("pointerdown", () => {
    els.dragging = true;
  });
  const release = () => {
    els.dragging = false;
  };
  slider.addEventListener("pointerup", release);
  slider.addEventListener("pointercancel", release);
  slider.addEventListener("input", () => {
    pct.textContent = slider.value;
    paintFill();
    sendVolume(flow, Number(slider.value) / 100);
  });
  // Dragging the thumb must not swipe to another pill.
  slider.addEventListener("mousedown", (e) => e.stopPropagation());
  const device = h(
    "button",
    { class: "audio-device", title: `${current?.name ?? ""}\nChoose another device`, onclick: onDevices },
    h("b", { text: name }),
    driver ? h("span", { text: driver }) : null,
    svg(ICONS.chevronRight, 7, { stroke: 2.4 }),
  );
  return h("div", { class: "audio-row" }, mute, device, slider, pct);
}

/** New volumes from a poll, without rebuilding (a slider being dragged keeps the user's value). */
export function patchAudioCard() {
  const d = get("integration_audio");
  for (const flow of ["output", "input"] as const) {
    const els = audioEls[flow];
    const lvl = audioLevel(d, flow);
    if (!els || !els.slider.isConnected || !lvl || els.dragging || volumeTimers[flow] != null) continue;
    els.slider.value = volumePct(lvl.volume);
    els.slider.style.setProperty("--fill", `${els.slider.value}%`);
    els.pct.textContent = volumePct(lvl.volume);
  }
}

function audioCard(onDevices: () => void): HTMLElement {
  const d = get("integration_audio");
  const users = micUsers(d);
  const badge = micBadge(d);
  const chip = users.length
    ? h(
        "span",
        { class: badge === "muted" ? "mic-chip muted" : "mic-chip", title: badge === "muted" ? "Your mic is muted" : "Your mic is live" },
        h("i"),
        h("span", { text: `${badge === "muted" ? "Muted" : "Live"} · ${micUsersLabel(users)}` }),
      )
    : null;
  const more = h("button", { class: "int-more", title: "Devices", onclick: onDevices }, svg(ICONS.ellipsis, 8));
  const right = h("span", { class: "int-head-right" }, chip, more);
  return h(
    "div",
    { class: "int-card audio-card" },
    header(AUDIO_COLOR, "Audio", "", right),
    h("div", { class: "audio-rows" }, audioRow("output", onDevices), audioRow("input", onDevices)),
  );
}

function audioDetail(onBack: () => void): HTMLElement {
  const d = get("integration_audio");
  const list = h("div", { class: "int-rows scroll audio-devices" });
  for (const [flow, label] of [["outputs", "Output"], ["inputs", "Input"]] as const) {
    const devices = (Array.isArray(d[flow]) ? d[flow] : []) as AudioDevice[];
    list.append(h("div", { class: "audio-section", text: label }));
    if (devices.length === 0) list.append(h("div", { class: "int-status", text: "No device." }));
    for (const dev of devices) {
      const [name, driver] = splitDeviceName(dev.name);
      const row = h(
        "button",
        {
          class: dev.isDefault ? "audio-pick on" : "audio-pick",
          title: dev.isDefault ? "In use" : `Use ${dev.name}`,
          onclick: () => {
            if (dev.isDefault) return;
            row.classList.add("busy");
            void Bridge.audioSetDefault(dev.id);
          },
        },
        h("i"),
        h("b", { text: name }),
        driver ? h("span", { text: driver }) : null,
      );
      list.append(row);
    }
  }
  list.addEventListener("mousedown", (e) => e.stopPropagation());
  return detailFrame(AUDIO_COLOR, "Audio devices", onBack, list);
}

/** What the overview card is rebuilt from: the Audio card ignores volume changes (patched in place). */
export function personalDataKey(id: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  return id === "integration_audio" ? audioCardKey(d) : JSON.stringify(d);
}

// ── Shared ────────────────────────────────────────────────────────────────────

function detailFrame(color: string, title: string, onBack: () => void, body: HTMLElement): HTMLElement {
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(color, 6),
      h("b", { text: title }),
    ),
    body,
  );
}

/** What the idle card says before a personal pill has anything to show. */
export function personalIdleLabel(id: string): string {
  switch (id) {
    case "integration_quota":
      return "Waiting for the Claude Code status line…";
    case "integration_space":
      return "Loading today from Space…";
    case "integration_media":
      return "Nothing playing.";
    case "integration_messages":
      return "No new messages.";
    case "integration_shelf":
      return "Looking at your screenshots and downloads…";
    case "integration_audio":
      return "Looking for audio devices…";
    default:
      return "";
  }
}

export function hasPersonalData(id: string): boolean {
  const info = State.integrations[id];
  if (!info || info.error) return false;
  const d = get(id);
  switch (id) {
    case "integration_quota":
      return d.fiveHour != null || d.sevenDay != null;
    case "integration_space":
      return typeof d.date === "string";
    case "integration_media":
      return str(d.title) !== "";
    case "integration_messages":
      return arr(id, "messages").length > 0;
    // Always a card once polled: an empty shelf says how to fill it.
    case "integration_shelf":
      return Array.isArray(d.pinned);
    case "integration_audio":
      return Array.isArray(d.outputs);
    default:
      return false;
  }
}

/** The card for a personal pill, or null to fall back to the idle card. */
export function renderPersonalCard(
  task: AgentTask,
  detailOpen: boolean,
  openDetail: () => void,
  closeDetail: () => void,
): HTMLElement | null {
  if (!hasPersonalData(task.id)) return null;
  switch (task.id) {
    case "integration_quota":
      return quotaCard();
    case "integration_space":
      return detailOpen ? spaceDetail(closeDetail) : spaceCard(openDetail);
    case "integration_media":
      if (!detailOpen && search) {
        // The detail was closed (back button, another pill): so is its search.
        if (search.focused) void Bridge.focusWindow(false);
        search = null;
      }
      return detailOpen ? mediaDetail(closeDetail, openDetail) : mediaCard(openDetail);
    case "integration_messages":
      return detailOpen ? messagesDetail(closeDetail) : messagesCard(openDetail);
    case "integration_shelf":
      return shelfCard();
    case "integration_audio":
      return detailOpen ? audioDetail(closeDetail) : audioCard(openDetail);
    default:
      return null;
  }
}
