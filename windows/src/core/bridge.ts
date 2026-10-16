// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";
import type { RecapHistory, RecapPrefs } from "../recap/summary";
import type { Lyrics, LyricHit } from "../views/lyrics";

/** Credential Manager entry of the chat's Anthropic API key. */
export const API_KEY_SECRET = "anthropic-api-key";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

/** A connected display, as Settings lists it (island.rs MonitorChoice). */
export interface DisplayChoice {
  key: string;
  label: string;
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),
  /** Which of these sounds have a file of the user's own in the sounds folder. */
  customSounds: (names: readonly string[]) => call<string[]>("custom_sounds", { names }),
  /** The user's file for one sound, as raw bytes. */
  customSound: (name: string) => call<ArrayBuffer>("custom_sound", { name }),
  revealSoundsFolder: () => call<void>("reveal_sounds_folder"),
  /** Tells the island to read the sounds folder again ("sounds-changed"). */
  reloadSounds: () => call<void>("reload_sounds"),
  // ── Weekly recap ──────────────────────────────────────────────────────────
  /** Turns and decisions from `since` (Unix seconds) on, plus the recap prefs. */
  recapHistory: (since: number) => call<RecapHistory>("recap_history", { since: Math.floor(since) }),
  recapPrefs: () => call<RecapPrefs>("recap_prefs"),
  recapSetEnabled: (enabled: boolean) => call<void>("recap_set_enabled", { enabled }),
  recapSetHideProjects: (hide: boolean) => call<void>("recap_set_hide_projects", { hide }),
  /** `week` is the Monday (YYYY-MM-DD) the recap opened on its own for. */
  recapMarkShown: (week: string) => call<void>("recap_mark_shown", { week }),
  recapClear: () => call<void>("recap_clear"),
  /** Writes the PNG (a data URL) into Pictures or Downloads; returns its path. */
  recapSavePng: (data: string, week: string) => callOrThrow<string>("recap_save_png", { data, week }),
  /** Opens the folder of the image saved last. */
  recapRevealSaved: () => call<void>("recap_reveal_saved"),

  /** The GitHub card is on screen: refetch that part if it is stale. */
  githubRefresh: (section: "pulse" | "activity") => call<void>("github_refresh", { section }),

  /** Displays the island can be pinned to: `key` is what `settings.screen` stores. */
  listMonitors: () => call<DisplayChoice[]>("list_monitors"),
  /** Corrects the webview zoom when its pixel ratio is not the window's scale; true when it changed. */
  fitZoom: (dpr: number) => call<boolean>("fit_zoom", { dpr }),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  /**
   * "Open terminal": the window the session runs in when Rust found it
   * (Windows), else the folder in VS Code.
   */
  openSession: (sessionId: string | null, path: string | null) =>
    call<boolean>("open_session", { sessionId, path }),

  /** The diff card's ↗: an existing file, in VS Code; never launched by its type. */
  openFileInVSCode: (path: string) => call<boolean>("open_file_in_vscode", { path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  /** "allow" / "deny", or a JSON line: {"plan":mode}, {"feedback":…}, {"answers":…}. */
  approvalDecision: (requestId: string, decision: string) =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string }>("chat_send", { query, context }),
  chatReset: () => call<void>("chat_reset"),
  /** Play/pause, next or previous on the media session the Music pill shows. */
  mediaControl: (action: string) => call<void>("media_control", { action }),
  /** The Music card's cover as a data URL; `id` matches the poll's `artId`. */
  mediaArt: () => call<{ id: number; url: string } | null>("media_art"),
  /** Lyrics from lrclib.net; null when there are none or the Lyrics preference is off. Throws on a network failure. */
  mediaLyrics: (title: string, artist: string, album: string, durationMs: number | null) =>
    callOrThrow<Lyrics | null>("media_lyrics", { title, artist, album, durationMs }),
  /** The lyrics detail's manual search on lrclib.net, best rows for this song first. */
  lyricsSearch: (query: string, durationMs: number | null) =>
    callOrThrow<LyricHit[]>("lyrics_search", { query, durationMs }),
  /** Uses LRCLIB record `id` for this song from now on; null goes back to the automatic match. */
  lyricsChoose: (title: string, artist: string, album: string, durationMs: number | null, id: number | null) =>
    callOrThrow<Lyrics | null>("lyrics_choose", { title, artist, album, durationMs, id }),
  // ── Shelf (each action only on a file the card shows) ─────────────────────
  /** Keeps dropped files on the shelf, by reference. */
  shelfPin: (paths: string[]) => callOrThrow<void>("shelf_pin", { paths }),
  shelfUnpin: (path: string) => call<void>("shelf_unpin", { path }),
  shelfClear: () => call<void>("shelf_clear"),
  /** Explorer's thumbnail or icon as a PNG data URL. */
  shelfThumb: (path: string) => call<string | null>("shelf_thumb", { path }),
  shelfOpen: (path: string) => callOrThrow<void>("shelf_open", { path }),
  shelfReveal: (path: string) => callOrThrow<void>("shelf_reveal", { path }),
  /** As a file, and as a picture when it is one. */
  shelfCopy: (path: string) => callOrThrow<void>("shelf_copy", { path }),
  /** Drags real files out of the island; resolves when the drag ends (true = dropped). */
  shelfDrag: (paths: string[]) => call<boolean>("shelf_drag", { paths }),

  // ── Audio ─────────────────────────────────────────────────────────────────
  audioSetDefault: (id: string) => call<void>("audio_set_default", { id }),
  audioSetVolume: (flow: "output" | "input", volume: number) => call<void>("audio_set_volume", { flow, volume }),
  audioSetMute: (flow: "output" | "input", muted: boolean) => call<void>("audio_set_mute", { flow, muted }),

  /** Brings a messaging app forward; Rust maps the name to its URL scheme. */
  openApp: (app: string) => call<void>("open_app", { app }),
  /** True while a fullscreen game, video or presentation is in front. */
  fullscreenActive: () => call<boolean>("fullscreen_active"),
  /** Takes these messages off the Messages card; null clears them all. */
  dismissMessages: (ids: number[] | null) => call<void>("dismiss_messages", { ids }),
  /** Where the Claude Code CLI is, for the chat that runs on the user's login. */
  claudeCliStatus: () => call<{ found: boolean; path: string }>("claude_cli_status"),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  // ── Global shortcuts (src-tauri/src/shortcuts/) ────────────────────────────
  /** How each global shortcut went when Rust last registered them. */
  shortcutsStatus: () => call<ShortcutsReport>("shortcuts_status"),
  /** Lets go of every global shortcut while Settings records a new one. */
  shortcutsSuspend: (suspended: boolean) => call<void>("shortcuts_suspend", { suspended }),

  // ── Mochi on the desktop (src-tauri/src/desktop/) ──────────────────────────
  desktopInfo: () => call<DesktopInfo>("desktop_mochi_info"),
  /** Starts a drag out of the island at the pointer (island-window coordinates). */
  desktopPickUp: (x: number, y: number) => call<boolean>("desktop_mochi_pick_up", { x, y }),
  /** Linux: the island page reports the pointer while it carries him. */
  desktopCarry: (x: number, y: number) => call<void>("desktop_mochi_carry", { x, y }),
  desktopCarryEnd: (x: number, y: number) => call<void>("desktop_mochi_carry_end", { x, y }),
  /** A drag started on the desktop Mochi; resolves to his top-left corner. */
  desktopDragBegin: () => call<[number, number] | null>("desktop_mochi_drag_begin"),
  /** X11: the page moves the window itself, physical pixels. */
  desktopDragMove: (x: number, y: number) => call<void>("desktop_mochi_drag_move", { x, y }),
  desktopDragEnd: (x: number, y: number) => call<void>("desktop_mochi_drag_end", { x, y }),
  /**
   * Shows him at the island and flies him to his spot. False: no spot to go to.
   * `anywhere` (the desktop shortcut): the first-visit corner then, rather than staying home.
   */
  desktopFlyOut: (anywhere = false) => call<boolean>("desktop_mochi_fly_out", { anywhere }),
  /** Flies him into the island and hides him. `forget`: he lives there again. */
  desktopFlyHome: (forget: boolean) => call<boolean>("desktop_mochi_fly_home", { forget }),
  /** Asleep, Rust stops the cursor poll and the window listens for the pointer. */
  desktopSetAsleep: (asleep: boolean) => call<void>("desktop_mochi_set_asleep", { asleep }),
  /**
   * Asks the Codex CLI (`codex app-server`) for its plan limits, as Codex's
   * /status does (codex_plan.rs). Only the limits and the free resets of the
   * `account/rateLimits/read` result, or null when Codex is missing, not
   * signed in, slow (15 s), already being asked, or Coucou is paused.
   */
  codexPlanUsage: () => call<unknown>("codex_plan_usage"),
};

export type ShortcutStatus =
  | "active" | "off" | "inUse" | "duplicate" | "invalid"
  | "typesCharacter" | "unsupported" | "notPorted";

export interface ShortcutsReport {
  actions: { id: string; status: ShortcutStatus; typed?: string }[];
  /** "wayland" or "no-display" when no global shortcut can be registered. */
  blocked: string | null;
  /** `<executable> --shortcut`: append an action id for a desktop shortcut. */
  command: string;
}

/** How the desktop Mochi's window works here (desktop platform mode). */
export type DesktopMode = "poll" | "window" | "layer" | "off";

export interface DesktopInfo {
  mode: DesktopMode;
  /** He was on the desktop when the app last quit. */
  onDesktop: boolean;
}

/** An event for one window only (island to desktop Mochi and back). Never throws. */
export async function emitToWindow(label: string, event: string, payload?: unknown) {
  if (!IS_TAURI) return;
  try {
    await emitTo(label, event, payload);
  } catch (err) {
    console.error(`[coucou] emit ${event} failed`, err);
  }
}

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

interface WebView2Bridge {
  postMessageWithAdditionalObjects?(message: string, objects: FileList): void;
}

function webview2(): WebView2Bridge | null {
  return (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview ?? null;
}

/**
 * On Windows WebView2 takes the drop (src-tauri/src/webdrop.rs): the page
 * sees ordinary HTML5 drag events, and on drop hands the files to Rust, which
 * answers with their paths as `island-drop`. Only drags that carry files count.
 */
function watchPageDrops(handler: (e: DragDropPayload) => void) {
  const bridge = webview2();
  if (!bridge?.postMessageWithAdditionalObjects) return;
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  // dragenter/dragleave fire for every element crossed: count them.
  let depth = 0;
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) handler({ type: "enter" });
  });
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    // Without this the page refuses the drop.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    handler({ type: "over" });
  });
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    if (depth > 0 && --depth === 0) handler({ type: "leave" });
  });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    const files = e.dataTransfer?.files;
    if (files && files.length) bridge.postMessageWithAdditionalObjects?.("coucou-drop", files);
    else handler({ type: "leave" });
  });
}

/**
 * Files dragged onto the island. Only reaches us when the window takes the
 * mouse. On Windows they come from the island's own drop target
 * (droptarget.rs, `island-drop`), which replaced wry's; elsewhere from Tauri.
 */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  watchPageDrops(handler);
  const own = await listen<DragDropPayload>("island-drop", (e) => handler(e.payload));
  const tauri = await getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
  return () => {
    own();
    tauri();
  };
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
