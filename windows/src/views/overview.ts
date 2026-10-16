// Home: the focused pill's card, or the board of every agent session.
// Split out of views.ts.

import { Bridge } from "../core/bridge";
import { sessionDiffs } from "../core/sessionDiffs";
import { State, type AgentTask } from "../core/state";
import { isSessionPill } from "../island/sessions";
import { buildBoardView } from "./boardView";
import { SwipeAccumulator, dragDirection, slideDirection, stepFocus } from "./carousel";
import { buildDiffCard } from "./diff";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { card } from "./parts";
import { personalDataKey } from "./personal";
import type { ViewActions, ViewHost } from "./views";

// ── Overview ──────────────────────────────────────────────────────────────────

/** A pill that is an agent session: what Home's board shows. */
function isBoardSession(t: AgentTask): boolean {
  if (isSessionPill(t.id) || t.id.startsWith("agent_")) return true;
  // The Claude Code catch-all, while a session without its own pill runs.
  return t.id === "integration_claude" && (t.state !== "idle" || t.steps.length > 0);
}

/** What the overview keeps between syncs. */
interface Overview {
  slot: HTMLElement;
  leftBody: HTMLElement;
  board: ReturnType<typeof buildBoardView>;
  detailOpen: boolean;
  lastFocus: string | null;
  mode: "board" | "card" | "diff" | null;
  /** The live diff open over the board (a tile's +N −M was clicked). */
  diff: { pillId: string; diffId: number } | null;
  /** What the shown card was built from; a change rebuilds it. */
  cardKey: string;
  /** Pending re-sync that moves the board's "3 min" labels along. */
  clockTimer: number | null;
}

/** The board's times read in minutes: re-sync once a minute while it is on screen. */
const BOARD_CLOCK_MS = 60_000;

const focusIds = () => State.visibleTasks.map((t) => t.id);

/** Wheel, tilt and drag move to the next or previous pill (views/carousel.ts). */
function wireCarousel(el: HTMLElement, actions: ViewActions) {
  const go = (dir: -1 | 1) => {
    const next = stepFocus(focusIds(), State.focusTask?.id ?? null, dir);
    if (next && next !== State.focusTask?.id) actions.setFocus(next);
  };
  const swipe = new SwipeAccumulator();
  el.addEventListener("wheel", (e) => {
    const dir = swipe.add(e.deltaX, e.deltaY, performance.now());
    if (dir !== 0) go(dir);
  }, { passive: true });
  let dragFrom: { x: number; y: number } | null = null;
  el.addEventListener("mousedown", (e) => {
    dragFrom = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("mouseup", (e) => {
    if (!dragFrom) return;
    const dir = dragDirection(e.clientX - dragFrom.x, e.clientY - dragFrom.y);
    dragFrom = null;
    if (dir !== 0) go(dir);
  });
}

/** A pill card's detail view opens and closes through these. */
function cardHooks(o: Overview, actions: ViewActions): IntegrationCardHooks {
  const setDetail = (open: boolean) => {
    o.detailOpen = open;
    o.cardKey = "";
    State.notify();
  };
  return {
    get detailOpen() {
      return o.detailOpen;
    },
    openDetail: () => setDetail(true),
    closeDetail: () => setDetail(false),
    openSettings: () => actions.openSettingsWindow(),
  };
}

/** A new pill in focus: slide it in from the side its chip lives on, start afresh. */
function onFocusChange(o: Overview, id: string | null) {
  const dir = slideDirection(focusIds(), o.lastFocus, id);
  if (dir !== 0) {
    o.slot.classList.remove("slide-next", "slide-prev");
    void o.slot.offsetWidth; // restart the animation
    o.slot.classList.add(dir > 0 ? "slide-next" : "slide-prev");
  }
  o.lastFocus = id;
  o.detailOpen = false;
  o.cardKey = "";
  o.mode = null;
  setDiff(o, null);
}

/** Whether Home shows a diff card: the island grows for it, as for Messages. */
let diffCardShown = false;
export const diffCardOpen = () => diffCardShown;

function setDiff(o: Overview, open: Overview["diff"]) {
  o.diff = open;
  diffCardShown = open != null;
}

/** A tile's +N −M: its session takes the focus and the diff card opens. */
function openDiff(o: Overview, pillId: string, diffId: number) {
  if (State.focusTask?.id !== pillId) State.setFocus(pillId);
  // Already focused here, so the focus change does not close the card again.
  o.lastFocus = State.focusTask?.id ?? null;
  setDiff(o, { pillId, diffId });
  o.mode = null;
  State.notify();
}

/** The open diff card; false (and the card closed) once its diff is gone. */
function syncDiff(o: Overview): boolean {
  const open = o.diff;
  if (!open) return false;
  const diff = sessionDiffs.find(open.pillId, open.diffId);
  if (!diff) {
    setDiff(o, null);
    return false;
  }
  if (o.mode === "diff") return true;
  o.mode = "diff";
  o.cardKey = "";
  clear(o.leftBody);
  o.leftBody.append(buildDiffCard(diff, {
    dismiss: () => {
      setDiff(o, null);
      o.mode = null;
      State.notify();
    },
    open: (path) => void Bridge.openFileInVSCode(path),
  }));
  return true;
}

function syncBoard(o: Overview, task: AgentTask) {
  if (o.mode !== "board") {
    clear(o.leftBody);
    o.leftBody.append(o.board.el);
    o.mode = "board";
    o.cardKey = "";
  }
  o.board.sync(State.visibleTasks.filter(isBoardSession), task.id, performance.now());
  // Only while the open island shows the board, so a hidden island stays at 0 % CPU.
  if (o.clockTimer === null && State.mode === "expanded" && State.view === "overview") {
    o.clockTimer = window.setTimeout(() => {
      o.clockTimer = null;
      State.notify();
    }, BOARD_CLOCK_MS);
  }
}

/** Every other pill shows its own card, exactly like IntegrationCardView. */
function syncCard(o: Overview, task: AgentTask, hooks: IntegrationCardHooks) {
  const info = State.integrations[task.id];
  const key = [
    task.id, o.detailOpen, task.state, task.steps.join("|"),
    info?.loaded, info?.error, info?.configured,
    personalDataKey(task.id, info?.data ?? {}),
  ].join("~");
  if (key === o.cardKey) return;
  o.cardKey = key;
  o.mode = "card";
  clear(o.leftBody);
  o.leftBody.append(renderIntegrationCard(task, hooks));
}

export function buildOverview(actions: ViewActions): ViewHost {
  const leftBody = h("div", { class: "left-body" });
  const jump = h("button", { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8));
  // One pill at a time, full width; the chips in the header say which.
  const slot = h("div", { class: "left" }, card(null, leftBody, jump));
  const el = h("div", { class: "view overview" }, slot);
  wireCarousel(el, actions);
  const o: Overview = {
    slot, leftBody,
    board: buildBoardView((id) => actions.setFocus(id), (id, diffId) => openDiff(o, id, diffId)),
    detailOpen: false, lastFocus: null, mode: null, diff: null, cardKey: "", clockTimer: null,
  };
  const hooks = cardHooks(o, actions);
  return {
    el,
    sync() {
      const task = State.focusTask;
      if ((task?.id ?? null) !== o.lastFocus) onFocusChange(o, task?.id ?? null);
      // An open diff card covers the board; it has its own ↗ for the file.
      const diffShown = syncDiff(o);
      if (!diffShown && task) {
        // An agent session shows the board of every session.
        if (isBoardSession(task)) syncBoard(o, task);
        else syncCard(o, task, hooks);
      }
      jump.style.display = o.detailOpen || diffShown ? "none" : "";
    },
  };
}
