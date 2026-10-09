// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes
// and wording are copied from the Swift views so both platforms read the same;
// colours and shapes are the Windows "Mochi Pop" look (style.css).

import { personalDataKey } from "./personal";
import { h, svg, clear, dot } from "./dom";
import { API_KEY_SECRET, Bridge } from "../core/bridge";
import { ICONS } from "./icons";
import { buildBoardView } from "./boardView";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { buildAnswers, type AskAnswer } from "../island/askQuestion";
import { isSessionPill } from "../island/sessions";
import { SwipeAccumulator, dragDirection, slideDirection, stepFocus } from "./carousel";

// The header lives in header.ts; island.ts takes it from here with the views.
export { buildHeader, headerMicBadge } from "./header";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  decidePlan(choice: PlanChoice): void;
  /** null = "Reply in terminal". */
  answerQuestion(answers: Record<string, string | string[]> | null): void;
  /** The island takes keyboard focus while one of its text fields is open. */
  wantKeyboard(on: boolean): void;
  /** The choose card's "Keep on shelf": pins what was just dropped. */
  keepOnShelf(): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** True while the view still needs frames (a transition in flight). */
  busy?(): boolean;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

/** "allow" is the approval's Allow: green, so it never reads as the pink default action. */
function btn(
  label: string,
  kind: "primary" | "secondary" | "allow",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

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
  mode: "board" | "card" | null;
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

function buildOverview(actions: ViewActions): ViewHost {
  const leftBody = h("div", { class: "left-body" });
  const jump = h("button", { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8));
  // One pill at a time, full width; the chips in the header say which.
  const slot = h("div", { class: "left" }, card(null, leftBody, jump));
  const el = h("div", { class: "view overview" }, slot);
  wireCarousel(el, actions);
  const o: Overview = {
    slot, leftBody, board: buildBoardView((id) => actions.setFocus(id)),
    detailOpen: false, lastFocus: null, mode: null, cardKey: "", clockTimer: null,
  };
  const hooks = cardHooks(o, actions);
  return {
    el,
    sync() {
      const task = State.focusTask;
      if ((task?.id ?? null) !== o.lastFocus) onFocusChange(o, task?.id ?? null);
      // An agent session shows the board of every session.
      if (task && isBoardSession(task)) syncBoard(o, task);
      else if (task) syncCard(o, task, hooks);
      jump.style.display = o.detailOpen ? "none" : "";
    },
  };
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "allow", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Plan (ExitPlanMode) ───────────────────────────────────────────────────────

export type PlanMode = "bypassPermissions" | "acceptEdits" | "default";
export type PlanChoice = { mode: PlanMode } | { feedback: string };

/** The terminal's "Ready to code?" choices, in the same order. */
const PLAN_CHOICES: { mode: PlanMode; label: string; hint: string }[] = [
  { mode: "bypassPermissions", label: "Yes, bypass", hint: "Yes, and switch to bypass permissions (no further prompts)" },
  { mode: "acceptEdits", label: "Yes, accept edits", hint: "Yes, and auto-accept edits" },
  { mode: "default", label: "Yes, manual", hint: "Yes, manually approve edits" },
];

/** A single-line text field with Send and ✕, styled like the chat bar. */
function textField(
  placeholder: string,
  onSend: (text: string) => void,
  onCancel: () => void,
): { el: HTMLElement; input: HTMLInputElement } {
  const input = h("input", {
    class: "chat-input",
    type: "text",
    placeholder,
    spellcheck: "false",
    autocomplete: "off",
  }) as HTMLInputElement;
  const send = () => {
    if (input.value.trim()) onSend(input.value);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
    // Escape closes the field only; the window handler would close the island.
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  });
  const el = h(
    "div",
    { class: "chat-bar" },
    input,
    btn("Send", "primary", send),
    h("button", { class: "link-btn", text: "✕", title: "Cancel", onclick: onCancel }),
  );
  return { el, input };
}

function buildPlan(actions: ViewActions): ViewHost {
  const head = h("div", { class: "card-head" });
  const text = h("div", { class: "plan-text" });
  const bottom = h("div");
  const el = h(
    "div",
    { class: "view" },
    card("indigo", stack(116, 16, head, text, bottom)),
  );
  (el.querySelector(".stack") as HTMLElement).classList.add("top");

  // Rebuilt only when the request or the mode changes: a rebuild between a
  // mouse-down and a mouse-up would swallow the click.
  let key = "";
  let writing = false;

  function closeField() {
    writing = false;
    actions.wantKeyboard(false);
    key = "";
    State.notify();
  }

  return {
    el,
    sync() {
      const req = State.pendingApproval;
      const k = `${req?.requestId ?? ""}~${writing}`;
      if (k === key) return;
      if (req?.requestId !== key.split("~")[0]) writing = false;
      key = `${req?.requestId ?? ""}~${writing}`;

      clear(head);
      head.append(agentWho(State.focusTask, "has a plan ready"));
      text.textContent = req?.plan?.trim() || "The plan is in the terminal.";
      text.scrollTop = 0;

      clear(bottom);
      if (writing) {
        const field = textField(
          "Tell Claude what to change…",
          (note) => {
            writing = false;
            actions.decidePlan({ feedback: note });
          },
          closeField,
        );
        bottom.append(field.el);
        actions.wantKeyboard(true);
        window.setTimeout(() => field.input.focus(), 120);
        return;
      }
      const row = h("div", { class: "actions" });
      for (const c of PLAN_CHOICES) {
        const b = btn(c.label, c.mode === "bypassPermissions" ? "primary" : "secondary", () =>
          actions.decidePlan({ mode: c.mode }),
        );
        b.title = c.hint;
        row.append(b);
      }
      const change = btn("Change plan…", "secondary", () => {
        writing = true;
        State.notify();
      });
      change.title = "No, tell Claude what to change";
      row.append(change);
      bottom.append(row);
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const head = h("div", { class: "card-head" });
  const header = h("div", { class: "ask-header" });
  const title = h("div", { class: "ask-question" });
  const body = h("div");
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, head, header, title, body)));
  const stackEl = el.querySelector(".stack") as HTMLElement;

  let key = "";
  /** Typing an "Other" answer for the question on screen. */
  let other = false;
  /** Multi-select picks for the question on screen. */
  let picks = new Set<string>();

  /** Records this question's answer, then shows the next one or sends them all. */
  function commit(answer: AskAnswer) {
    const q = State.pendingQuestion;
    if (!q) return;
    q.answers[q.index] = answer;
    if (other) actions.wantKeyboard(false);
    other = false;
    picks = new Set();
    if (q.index + 1 < q.items.length) {
      q.index += 1;
      key = "";
      actions.blip();
      State.notify();
    } else {
      actions.answerQuestion(buildAnswers(q.items, q.answers));
    }
  }

  function legacy() {
    // A question seen only through a Notification: nothing to answer here.
    stackEl.classList.remove("top");
    clear(head);
    head.append(agentWho(State.focusTask, "Claude Code is asking a question"));
    header.textContent = "";
    title.textContent = State.focusTask?.steps.at(-1) ?? "Claude needs an answer.";
    clear(body);
    body.append(h("div", { class: "sub", text: "Answer in your terminal." }));
  }

  return {
    el,
    sync() {
      const q = State.pendingQuestion;
      if (!q) {
        key = "";
        legacy();
        return;
      }
      const k = `${q.requestId}~${q.index}~${other}~${[...picks].join("|")}`;
      if (k === key) return;
      key = k;
      stackEl.classList.add("top");

      const item = q.items[q.index];
      clear(head);
      head.append(agentWho(State.focusTask, "is asking"));
      if (q.items.length > 1) {
        head.append(h("span", { class: "count", text: `${q.index + 1}/${q.items.length}` }));
      }
      head.append(h("button", {
        class: "link-btn",
        text: "Reply in terminal",
        onclick: () => {
          if (other) actions.wantKeyboard(false);
          other = false;
          actions.answerQuestion(null);
        },
      }));
      header.textContent = item.header;
      title.textContent = item.question;
      title.title = item.question;

      clear(body);
      if (other) {
        const field = textField(
          "Your answer…",
          (text) => commit({ kind: "other", text }),
          () => {
            other = false;
            actions.wantKeyboard(false);
            key = "";
            State.notify();
          },
        );
        body.append(field.el);
        actions.wantKeyboard(true);
        window.setTimeout(() => field.input.focus(), 120);
        return;
      }

      const chips = h("div", { class: "ask-chips" });
      for (const o of item.options) {
        const chip = h("button", {
          class: picks.has(o.label) ? "ask-chip on" : "ask-chip",
          text: o.label,
          title: o.description || o.label,
          onclick: () => {
            if (!item.multiSelect) {
              commit({ kind: "labels", labels: [o.label] });
              return;
            }
            if (picks.has(o.label)) picks.delete(o.label);
            else picks.add(o.label);
            State.notify();
          },
        });
        chips.append(chip);
      }
      chips.append(h("button", {
        class: "ask-chip other",
        text: "Other…",
        onclick: () => {
          other = true;
          State.notify();
        },
      }));
      body.append(chips);

      if (item.multiSelect) {
        const last = q.index + 1 >= q.items.length;
        const next = btn(last ? "Send" : "Next", "primary", () => {
          // Keep the options' order, not the click order.
          const labels = item.options.map((o) => o.label).filter((l) => picks.has(l));
          if (labels.length) commit({ kind: "labels", labels });
        });
        if (picks.size === 0) next.style.opacity = "0.4";
        // In the chip row itself: a row of its own falls off a short card.
        chips.append(next);
      }
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code finished"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

/** Auto-close choices of the in-island settings, in seconds. */
const AUTO_CLOSE_CHOICES = [10, 15, 30];
/** How often the Chat badge re-checks its key or CLI while the view is open. */
const CHAT_CHECK_MS = 10_000;
const BADGE_OK = "#22C55E";
const BADGE_MISSING = "#F4505E";

/** Whether the chat can answer: a saved API key, or the Claude Code CLI found. Cached. */
const chatReadiness = { ready: null as boolean | null, provider: "", checkedAt: -Infinity };

function refreshChatReadiness() {
  const provider = State.settings.chatProvider;
  const now = performance.now();
  if (provider === chatReadiness.provider && now - chatReadiness.checkedAt < CHAT_CHECK_MS) return;
  chatReadiness.provider = provider;
  chatReadiness.checkedAt = now;
  const check = provider === "cli"
    ? Bridge.claudeCliStatus().then((r) => r?.found === true)
    : Bridge.secretPresent(API_KEY_SECRET).then((v) => v === true);
  void check.then((ready) => {
    // A provider switched meanwhile has its own check on the way.
    if (provider !== chatReadiness.provider || ready === chatReadiness.ready) return;
    chatReadiness.ready = ready;
    State.notify();
  });
}

function badge(el: HTMLElement, ok: boolean, label: string) {
  clear(el);
  el.append(dot(ok ? BADGE_OK : BADGE_MISSING, 6), h("span", { text: label }));
}

function soundRow(actions: ViewActions) {
  const toggle = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  return {
    el: h("div", { class: "settings-row" }, toggle, h("span", { text: "Sound" }), volume),
    sync() {
      const s = State.settings;
      toggle.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
    },
  };
}

function autoCloseRow(actions: ViewActions) {
  const label = h("span", {});
  const choices = AUTO_CLOSE_CHOICES.map((s) => h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`));
  return {
    el: h("div", { class: "settings-row" }, svg(ICONS.timer, 12), label, h("div", { class: "seg" }, ...choices)),
    sync() {
      const secs = State.settings.autoCloseInterval;
      label.textContent = `Auto-close · ${Math.round(secs)}s`;
      choices.forEach((b, i) => b.classList.toggle("on", secs === AUTO_CLOSE_CHOICES[i]));
    },
  };
}

/** Claude Code hooks and the chat's readiness, and the way to the Settings window. */
function statusRow(actions: ViewActions) {
  const hooks = h("span", { class: "status-badge" });
  const chat = h("span", { class: "status-badge" });
  const open = h("button", { class: "link-btn settings-link", text: "Settings…", onclick: () => actions.openSettingsWindow() });
  return {
    el: h("div", { class: "settings-row status" }, hooks, chat, h("div", { class: "grow" }), open),
    sync() {
      badge(hooks, State.settings.hooksInstalled, "Claude Code");
      if (State.view === "settings") refreshChatReadiness();
      const via = State.settings.chatProvider === "cli" ? "Chat · CLI" : "Chat · API";
      badge(chat, chatReadiness.ready === true, via);
    },
  };
}

function buildSettings(actions: ViewActions): ViewHost {
  const rows = [soundRow(actions), autoCloseRow(actions), statusRow(actions)];
  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" },
      h("div", { class: "settings-rows" }, ...rows.map((r) => r.el)))));
  return {
    el,
    sync() {
      for (const r of rows) r.sync();
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("plan", buildPlan(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
