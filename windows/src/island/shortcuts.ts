// Keyboard shortcuts → island. Port of IslandWindowController.handleHotKey and
// handleIslandKey from the macOS app, via upstream Louis-CFM/coucou (2363550,
// 322e2ab).
//
// Global shortcuts are caught by Rust and arrive as a `shortcut` event with
// the action id (the wardrobe goes out as `open-wardrobe` instead). The
// in-island keys are read here, while the island has the keyboard: it takes
// it for the chat, and when a global shortcut opens it.
//
// This build's own cards: a permission or a plan is State.pendingApproval
// (`kind`), an AskUserQuestion is State.pendingQuestion; pills are the visible
// ones (the catch-all Claude Code pill hides behind its sessions).

import { Bridge, onEvent } from "../core/bridge";
import type { BotEmoteName, IslandViewName } from "../core/layout";
import { cyclePill, islandKeyAction, navigate, pillByNumber, type IslandKeyAction } from "../core/shortcuts";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { ViewCommand } from "../views/views";
import type { Island } from "./island";
import { wardrobeFromDesktop } from "./wardrobe";

/** What the shortcuts need from the island. */
export interface ShortcutHost {
  alert(view: IslandViewName): void;
  setView(view: IslandViewName): void;
  collapse(): void;
  emote(name: BotEmoteName): void;
  setPinned(on: boolean): void;
  /** Gives the island the keyboard, so the in-island keys work (Mac: makeKey). */
  takeKeyboard(): void;
  /** The wardrobe from any state, or back if it is open. */
  wardrobeAnywhere(): void;
  /** False where Mochi can't leave the island (GNOME on Wayland). */
  canLeaveIsland(): boolean;
  /** Mochi out to the desktop, or home (DesktopMochiController.flyOutOrHome). */
  flyOutOrHome(): void;
  /** Hands Ctrl+O / Ctrl+E to the view on screen (the Mac posts notifications). */
  viewCommand(command: ViewCommand): void;
}

const visibleIds = () => State.visibleTasks.map((t) => t.id);

function focusPill(host: ShortcutHost, id: string | null, open: boolean) {
  if (!id) return;
  State.setFocus(id);
  State.cardSelection = null;
  Sound.play("blip");
  if (open) host.alert("overview");
  else host.setView("overview");
}

/** Nothing to do for that key right now: Mochi says so. */
function grumble(host: ShortcutHost) {
  host.emote("annoyed");
  Sound.play("error");
}

/** The card waiting for an answer, and the pill it belongs to. */
function waitingCard(): { taskId: string; view: IslandViewName } | null {
  const approval = State.pendingApproval;
  if (approval) return { taskId: approval.taskId, view: approval.kind === "plan" ? "plan" : "approval" };
  const question = State.pendingQuestion;
  if (question) return { taskId: question.taskId, view: "question" };
  // A session asking in its terminal, with no card of ours.
  const asking = State.tasks.find((t) => t.state === "question");
  return asking ? { taskId: asking.id, view: "question" } : null;
}

/** Ctrl+Alt+A: its own pill to the front, its card up. Nothing is answered from here. */
function goToAlert(host: ShortcutHost, resume: () => void) {
  const card = waitingCard();
  if (!card) {
    grumble(host);
    return;
  }
  resume();
  State.setFocus(card.taskId);
  host.alert(card.view);
  host.takeKeyboard();
}

function toggleIsland(host: ShortcutHost, resume: () => void) {
  if (State.mode === "expanded") {
    host.collapse();
    return;
  }
  resume();
  // A waiting card is what the island opens on, with its own pill in front.
  const card = waitingCard();
  if (card) State.setFocus(card.taskId);
  host.alert(card?.view ?? State.defaultView());
  host.takeKeyboard();
}

/** The Mac brings the terminal forward; here it is the island's own "Open terminal". */
function jumpToTerminal(host: ShortcutHost) {
  const task = State.focusTask;
  void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null);
  if (State.mode === "expanded") host.collapse();
}

function muteToggle(host: ShortcutHost) {
  const on = !State.settings.soundEnabled;
  State.settings.soundEnabled = on;
  Sound.setEnabled(on);
  void Bridge.saveSettings(State.settings);
  if (on) Sound.play("tick");
  host.emote(on ? "happy" : "annoyed");
  State.notify();
}

/** The Mac's ⌃⌥D. Sending him out lifts Pause, as the other shortcuts do. */
function desktopToggle(host: ShortcutHost, resume: () => void) {
  if (!host.canLeaveIsland()) {
    grumble(host);
    return;
  }
  if (!State.mochiOnDesktop) resume();
  host.flyOutOrHome();
}

type GlobalAction = (host: ShortcutHost, resume: () => void) => void;

const GLOBAL_ACTIONS: Record<string, GlobalAction> = {
  toggleIsland,
  openChat: (host, resume) => {
    resume();
    host.alert("prompt");
  },
  goToAlert,
  jumpToTerminal: (host) => jumpToTerminal(host),
  nextPill: (host, resume) => {
    resume();
    focusPill(host, cyclePill(visibleIds(), State.focusTask?.id ?? null, 1), true);
  },
  prevPill: (host, resume) => {
    resume();
    focusPill(host, cyclePill(visibleIds(), State.focusTask?.id ?? null, -1), true);
  },
  muteToggle: (host) => muteToggle(host),
  desktopToggle,
};

/**
 * A global shortcut was pressed. `resume` lifts Pause, as the tray's Open
 * does. wardrobeToggle never comes this way (Rust sends `open-wardrobe`), and
 * attachFrontWindow isn't in this version.
 */
export function runGlobalShortcut(host: ShortcutHost, action: string, resume: () => void) {
  GLOBAL_ACTIONS[action]?.(host, resume);
}

/** Ctrl+K: a fresh chat, unless an answer is on its way (it would land in the new one). */
function newChat(host: ShortcutHost) {
  if (State.stateOverride === "thinking") return;
  State.chatHistory = [];
  State.droppedFile = null;
  State.promptContext = null;
  void Bridge.chatReset();
  Sound.play("blip");
  host.setView("prompt");
}

/** Ctrl+↓ / Ctrl+↑: only a card with a list counts its items (the GitHub lists, as on the Mac). */
function moveSelection(delta: number) {
  if (State.view !== "overview" || State.cardItemCount <= 0) return;
  State.cardSelection = navigate(State.cardSelection, delta, State.cardItemCount);
  State.notify();
}

type IslandAction<K extends IslandKeyAction["kind"]> = (
  host: ShortcutHost,
  action: Extract<IslandKeyAction, { kind: K }>,
) => void;

const ISLAND_ACTIONS: { [K in IslandKeyAction["kind"]]: IslandAction<K> } = {
  cycle: (host, a) => focusPill(host, cyclePill(visibleIds(), State.focusTask?.id ?? null, a.delta), false),
  pill: (host, a) => focusPill(host, pillByNumber(visibleIds(), a.number), false),
  list: (_host, a) => moveSelection(a.delta),
  openSelection: (host) => {
    if (State.cardSelection != null) host.viewCommand("openSelection");
  },
  diff: (host) => host.viewCommand("toggleDiff"),
  newChat: (host) => newChat(host),
  settings: () => void Bridge.openSettingsWindow(),
  // A permission card keeps the island pinned until it is answered.
  pin: (host) => {
    if (!State.pendingApproval) host.setPinned(!State.isPinned);
  },
};

/** A key the island acts on while it has the keyboard. */
export function runIslandKey(host: ShortcutHost, action: IslandKeyAction) {
  (ISLAND_ACTIONS[action.kind] as IslandAction<typeof action.kind>)(host, action as never);
}

function inTextField(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable === true;
}

/** The shortcuts' view of the island. */
export function islandShortcutHost(island: Island): ShortcutHost {
  return {
    alert: (view) => island.alert(view),
    setView: (view) => island.setView(view),
    collapse: () => island.collapse(),
    emote: (name) => {
      island.engine.triggerEmote(name);
      island.ensureRunning();
    },
    setPinned: (on) => setPinned(island, on),
    takeKeyboard: () => void Bridge.focusWindow(true),
    wardrobeAnywhere: () => wardrobeFromDesktop(island),
    canLeaveIsland: () => island.desktop.supported,
    flyOutOrHome: () => flyOutOrHome(island),
    viewCommand: (command) => island.views.get(State.view)?.command?.(command),
  };
}

/** Ctrl+P: keep the open island from folding away, or let it fold again. */
function setPinned(island: Island, on: boolean) {
  State.isPinned = on;
  island.fsm.pinned = on;
  // The countdown bar reads the state machine's deadline, cleared with it.
  if (on) island.fsm.cancelTimers();
  else if (!island.pointerInIsland && island.fsm.state === "home") island.fsm.mouseLeft();
  State.notify();
}

/**
 * The desktop shortcut. The greeting and the drop sequence draw a Mochi of
 * their own: he stays for them, as he does for a drag (botDrag.ts).
 */
function flyOutOrHome(island: Island) {
  const busy = State.mode === "expanded" && (State.view === "greeting" || island.uploadActive);
  if (busy && !State.mochiOnDesktop) return;
  island.desktop.flyOutOrHome();
}

export function registerShortcutHandlers(host: ShortcutHost, resume: () => void) {
  void onEvent<string>("shortcut", (action) => runGlobalShortcut(host, action, resume));
  // The wardrobe shortcut comes as its own event: it opens the wardrobe, or closes it again.
  void onEvent<null>("open-wardrobe", () => {
    resume();
    host.wardrobeAnywhere();
  });

  // Capture phase: the chat field stops its own key events from bubbling.
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (State.mode !== "expanded") return;
      const action = islandKeyAction(e, { view: State.view, inTextField: inTextField(e.target) });
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      runIslandKey(host, action);
    },
    true,
  );
}
