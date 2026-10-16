// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop } from "../core/bridge";
import {
  COMPACT_W, EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botPosition, chatPromptHeight,
  islandSize,
  type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { BotEngine } from "../mochi/engine";
import { type MusicContext } from "../mochi/acts";
import { Greeting } from "../mochi/greeting";
import { tickMiniBots } from "../mochi/minibots";
import { UploadCanvas } from "../upload/canvas";
import { UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, type ViewHost } from "../views/views";
import { diffCardOpen } from "../views/overview";
import { h } from "../views/dom";
import {
  hasPersonalData, lyricStripEl, lyricStripWidth, musicSinging, onLyricStripResize,
} from "../views/personal";
import { BotDrag } from "./botDrag";
import { BotHover } from "./botHover";
import { BotPainter } from "./botPainter";
import { CompactBar, lyricMode } from "./compactBar";
import { Countdown } from "./countdown";
import { DesktopLink } from "./desktop";
import { Dizzy } from "./dizzy";
import { FileDrop } from "./fileDrop";
import { IslandStateMachine, type FsmState } from "./fsm";
import { wireKeys } from "./keys";
import { wireLyricReveal } from "./lyricReveal";
import { buildViewActions } from "./viewActions";
import { WindowCollapse } from "./windowCollapse";
import { blockMenuOverMochi, dropPreviewOutsideWardrobe, rightClickedMochi, wardrobeFromDesktop } from "./wardrobe";
import {
  MESSAGE_GLANCE_S, focusAfterGlance, messageAlertAction, rememberGlance, type GlanceReturn,
} from "./messageAlert";

/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;
/** Height of the launch greeting's own canvas. */
const GREETING_H = 150;
/** Longest frame step, seconds: a stalled tab must not make springs jump. */
const MAX_FRAME_S = 0.05;
/** How long the chat field waits for its view to settle before taking the focus. */
const CHAT_FOCUS_DELAY_MS = 120;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/**
 * The page's real width: PANEL_W, unless the zoom correction was clamped or
 * the pixel ratio has not settled yet (upstream b9b9217 / #467). The island is
 * centred in it, so the hit test must be too.
 */
const viewportWidth = () => (window.innerWidth > 0 ? window.innerWidth : PANEL_W);

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private countdown = new Countdown();
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  /** The views by name; the shortcuts hand Ctrl+O / Ctrl+E to the one on screen. */
  views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  readonly engine = new BotEngine();
  private greeting = new Greeting();
  private greetingShown = false;
  private painter = new BotPainter(this.engine);
  private botHover = new BotHover(this.engine);
  private compactBar = new CompactBar();
  private fileDrop = new FileDrop(this);

  private running = false;
  private lastFrame = 0;
  private dirty = true;

  private windowCollapse = new WindowCollapse();
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  /** Set while a new message opens the island: its own sound already played. */
  private quietOpen = false;
  /** The pointer is on the wake strip (hidden island). */
  private stripHovered = false;
  /** What the Music acts need beyond the pill's data, read once a frame. */
  private music: MusicContext = {};
  /** The overview was last sized for the Messages card (MESSAGES_OVERVIEW_H). */
  private tallOverview = false;

  private dizzy = new Dizzy(this);
  /** Mochi on the desktop: his life cycle and the drag out of the island. */
  readonly desktop = new DesktopLink({
    reveal: () => this.reveal(),
    wardrobeFromDesktop: () => wardrobeFromDesktop(this),
    dizzyFromDesktop: () => this.dizzy.start(),
  });
  private botDrag = new BotDrag(this);
  /** Moments the Monday recap may open (recap/recap.ts): greeting over, waking up. */
  onGreetingDone: (() => void) | null = null;
  onWake: (() => void) | null = null;
  private lastSyncedView: IslandViewName | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    wireLyricReveal(this.fsm);
    // A lyric line wider than the collapsed island grows it; a short one shrinks it back.
    onLyricStripResize(() => {
      if (lyricMode()) this.animateGeometry(lyricStripWidth() < this.width.value);
    });
    // Focusing Messages (or its first message landing), or opening a diff card,
    // grows the overview; leaving shrinks it back.
    State.subscribe(() => {
      const tall = this.wantsTallOverview();
      if (tall === this.tallOverview) return;
      this.tallOverview = tall;
      if (State.mode === "expanded" && State.view === "overview") this.animateGeometry(!tall);
    });
    this.engine.onDizzy = () => this.dizzy.start();
    this.greeting.onComplete = () => {
      this.fsm.greetComplete();
      this.onGreetingDone?.();
    };
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions = buildViewActions(this);

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    this.uploadCanvas = this.buildUploadCanvas();

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.painter.glow,
      this.painter.canvas,
      this.compactBar.miniGrid,
      this.compactBar.micBadge,
      lyricStripEl(),
      this.countdown.el,
    );

    this.sizeGreetingCanvas();

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  /**
   * The drop sequence draws the card, the bar and its own Mochi. It sits under
   * the header, which stays visible on top of it exactly as on macOS.
   */
  private buildUploadCanvas(): UploadCanvas {
    return new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      shelf: () => this.keepDropOnShelf(),
      cancel: () => this.setView(State.defaultView()),
    });
  }

  private sizeGreetingCanvas() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(GREETING_H * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = `${GREETING_H}px`;
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.hoverOpens = State.settings.openOnHover;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          this.toPetit(from);
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
      if (from === "hidden") this.onWake?.();
      // The greeting is over, however it ended: back to his desktop spot.
      if (from === "coucou" && to !== "coucou") this.desktop.launch();
    };
  }

  /** Down to the compact island: ends the greeting, or peeks out of hiding. */
  private toPetit(from: FsmState) {
    if (from === "coucou") this.greeting.interrupt();
    else if (from === "hidden") Sound.play("peek");
    this.setMode("compact");
    if (from === "coucou") State.view = State.defaultView();
    if (!this.wasInIsland) this.fsm.mouseLeft();
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded" && !this.quietOpen) Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      void Bridge.focusWindow(false);
      // A message's glance is over: back to the pill it interrupted.
      const back = focusAfterGlance(this.glance, State.focusTask?.id ?? null, State.visibleTasks.map((t) => t.id));
      this.glance = null;
      if (back) State.setFocus(back);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.windowCollapse.update(mode);
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  /** A card that held Claude Code (approval, plan, question) has been answered. */
  finishCard() {
    // The session that asked, not a fixed pill: each session has its own.
    const taskId =
      State.pendingApproval?.taskId ?? State.pendingQuestion?.taskId ?? "integration_claude";
    State.pendingApproval = null;
    State.pendingQuestion = null;
    State.isPinned = false;
    this.fsm.pinned = false;
    State.updateTask(taskId, "working");
    State.setPillBadge(taskId, null);
    void Bridge.focusWindow(false);
    this.returnFocusAfterCard();
    this.setView(State.defaultView());
  }

  /**
   * A card takes the focus for the session that asks; remember the pill it took
   * it from (Music, say) so answering gives it back, as a message's glance does.
   */
  focusForCard(taskId: string) {
    this.cardGlance = rememberGlance(this.cardGlance, State.focusTask?.id ?? null, taskId);
    State.setFocus(taskId);
  }

  /** The card is gone (answered here or in the terminal, or timed out). */
  returnFocusAfterCard() {
    const back = focusAfterGlance(this.cardGlance, State.focusTask?.id ?? null, State.visibleTasks.map((t) => t.id));
    this.cardGlance = null;
    if (back) State.setFocus(back);
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /**
   * A new chat message: show it on the Messages pill instead of only beeping.
   * The island opens like a hover would and closes after the auto-close delay;
   * an approval, the chat or a pointer already in the island keeps it.
   */
  async showMessage(taskId: string) {
    const fullscreen = (await Bridge.fullscreenActive()) === true;
    const action = messageAlertAction({
      fullscreen,
      mode: State.mode,
      view: State.view,
      pinned: State.isPinned || this.fsm.pinned,
      waiting: State.pendingApproval != null || State.pendingQuestion != null,
      pointerInIsland: this.wasInIsland,
    });
    if (action === "none") {
      // Not even the compact island over a game or a film: the badge waits.
      if (!fullscreen) this.fsm.reveal();
      return;
    }
    // Remember where the message took the island from, to go back on close.
    this.glance = rememberGlance(this.glance, State.focusTask?.id ?? null, taskId);
    State.setFocus(taskId);
    if (action === "open") {
      // home → expand(overview), then mouseLeft() schedules the auto-close.
      this.quietOpen = true;
      try {
        this.fsm.forceHome();
      } finally {
        this.quietOpen = false;
      }
      // A glance, not the full auto-close: the bar counts the whole 3 s down.
      this.fsm.collapseAfter(MESSAGE_GLANCE_S);
    }
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  /** The choose card's "Keep on shelf". */
  keepDropOnShelf() {
    this.fileDrop.keepOnShelf();
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const compactW = lyricMode() ? lyricStripWidth() : COMPACT_W;
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length, compactW, this.wantsTallOverview());
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  /** The Messages card and an open diff card get the taller overview. */
  private wantsTallOverview(): boolean {
    const id = State.focusTask?.id;
    return (id === "integration_messages" && hasPersonalData(id)) || diffCardOpen();
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.compactBar.layout(w, hh);
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = { x: (viewportWidth() - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (viewportWidth() - w) / 2, y: 0, w, h: hh };
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      this.stripHovered = true;
      if (State.mode === "hidden") void this.hoverShow(() => this.stripHovered && State.mode === "hidden");
    });
    this.wakeStrip.addEventListener("mouseleave", () => {
      this.stripHovered = false;
    });
    // Over a fullscreen app a hover does nothing; a click still opens.
    this.wakeStrip.addEventListener("mousedown", () => {
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (rightClickedMochi(this, e)) return;
      // A press on Mochi slaps him once let go, or drags him out to the desktop.
      const onBot = this.botDrag.pressed(e);
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (onBot) this.botHover.cancel();
    });

    blockMenuOverMochi(this.islandEl, this);

    wireKeys(this);

    void onDragDrop((e) => this.fileDrop.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /**
   * A hover that would show the island, unless a fullscreen game, video or
   * presentation is in front: the cursor brushing the top of the screen must
   * not open Mochi over it. `still` re-checks the pointer once Rust answers.
   */
  private async hoverShow(still: () => boolean) {
    if ((await Bridge.fullscreenActive()) === true) return;
    if (!still()) return;
    this.fsm.mouseEntered();
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;
    this.trackIslandHover(inIsland);
    this.trackBotHover(x, y);
    this.ensureRunning();
  }

  /** The pointer crossing the island's edge: the state machine opens or closes it. */
  private trackIslandHover(inIsland: boolean) {
    // Updated before the FSM runs: its transition handlers read wasInIsland, and
    // a stale false made an island opened by hover schedule its own auto-close.
    const wasIn = this.wasInIsland;
    this.wasInIsland = inIsland;
    if (inIsland && !wasIn) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      if (this.fsm.hoverWouldShow) {
        void this.hoverShow(() => this.wasInIsland);
      } else {
        this.fsm.mouseEntered();
      }
    }
    if (!inIsland && wasIn) {
      // With Open on hover, leaving closes at once, except the chat: the pointer
      // drifts while typing. Without it the island was opened by a click and
      // waits for Auto-close, like anything else opened on purpose.
      this.fsm.mouseLeft(State.view !== "prompt" && State.settings.openOnHover);
    }
  }

  /** Resting on Mochi brings hearts; moving across him starts them again. */
  private trackBotHover(x: number, y: number) {
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    this.botHover.track(x, y, overBot);
  }

  /** The pointer is over the island (with the hit margin). */
  get pointerInIsland(): boolean {
    return this.wasInIsland;
  }

  /** A press on Mochi ends the hearts' hover. */
  cancelBotHover() {
    this.botHover.cancel();
  }

  isBotHit(x: number, y: number): boolean {
    // Out on the desktop, the island's Mochi is invisible: nothing to hit.
    if (State.mochiOnDesktop) return false;
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(MAX_FRAME_S, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    this.drawMochi(dt);
    this.drawUpload(nowMs);

    // Once a frame for every Mochi on screen: the Music pill sings along with its lyrics.
    this.music = { singing: musicSinging() };
    tickMiniBots(dt, this.music);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.fileDrop.stepSequence();
    this.countdown.update(this.fsm, nowMs);

    if (this.frameBusy()) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private get greetingActive(): boolean {
    return State.mode === "expanded" && State.view === "greeting";
  }

  /** The launch greeting draws its own Mochi; otherwise the island's one is drawn. */
  private drawMochi(dt: number) {
    if (!this.greetingActive) {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
      return;
    }
    const gctx = this.greetingCanvas.getContext("2d");
    if (!gctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.greeting.draw(gctx);
  }

  private drawUpload(nowMs: number) {
    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);
  }

  /**
   * Whether another frame is needed. Nothing is drawn while the island is
   * hidden, so nothing may keep the loop alive either. This used to read
   * `... || this.engine.busy || State.mode !== "hidden"`, and engine.busy is
   * permanently true for any state with a looping animation (breathing,
   * ratelimit sweat, sleeping z's, the search sweep), so a hidden island went
   * on burning frames in exactly the states it spends most of its life in.
   * Geometry still has to finish retracting.
   */
  private frameBusy(): boolean {
    const settling = this.width.animating || this.height.animating || this.radius.animating;
    if (State.mode === "hidden") return settling;
    const botMoving = !this.botCx.settled || !this.botCy.settled || !this.botSize.settled;
    return settling || botMoving || this.greetingActive || this.engine.busy || UploadSeq.isActive ||
      // A view mid-transition: stopping here froze it half-way once Mochi went still.
      (this.views.get(State.view)?.busy?.() ?? false);
  }

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    // The drop canvas draws its own Mochi; two of them would overlap. Out on the
    // desktop, he isn't here at all.
    const own = !this.greetingActive && !this.uploadActive && !State.mochiOnDesktop;
    this.painter.setVisible(p.opacity > 0 && own);
    const glows = State.mode === "expanded" && State.view !== "uploading" && own;
    this.painter.placeGlow(glows ? { cx: this.botCx.value, cy: this.botCy.value, diameter: p.diameter } : null);
  }

  private drawBot(dt: number) {
    const at = { cx: this.botCx.value, cy: this.botCy.value, size: this.botSize.value };
    this.painter.draw(dt, at, this.islandRect().x + at.cx, this.music);
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    // Leaving the greeting, however it ends, lets its sound fade out.
    if (this.greetingShown && !this.greetingActive) this.greeting.leave();
    this.greetingShown = this.greetingActive;
    dropPreviewOutsideWardrobe();
    const content = State.mode === "expanded" && !this.greetingActive;
    this.contentEl.style.opacity = content ? "1" : "0";
    this.contentEl.style.pointerEvents = content ? "auto" : "none";
    this.greetingCanvas.style.display = this.greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    this.syncKeyboardFocus();

    // Compact: the line being sung while the Music pill plays, else the mini grid.
    // Wider for a lyric line, back to the usual size after.
    if (this.compactBar.sync(this.width.value) && State.mode === "compact") this.animateGeometry(!lyricMode());
    this.engine.setState(State.effectiveState);
  }

  /**
   * The chat is the only view with a text field, so it is the only time the
   * island is allowed to take keyboard focus.
   */
  private syncKeyboardFocus() {
    if (this.lastSyncedView === State.view) return;
    const wasChat = this.lastSyncedView === "prompt";
    this.lastSyncedView = State.view;
    if (State.view === "prompt") {
      void Bridge.focusWindow(true);
      window.setTimeout(() => this.views.get("prompt")?.focus?.(), CHAT_FOCUS_DELAY_MS);
    } else if (wasChat) {
      void Bridge.focusWindow(false);
    }
  }


  /** Set while a new message holds the island on the Messages pill. */
  private glance: GlanceReturn | null = null;
  /** Set while an approval, plan or question card holds the island on its session's pill. */
  private cardGlance: GlanceReturn | null = null;

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.hoverOpens = State.settings.openOnHover;
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
