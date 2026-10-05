// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { buildAnswers, type AskAnswer } from "../island/askQuestion";
import { isSessionPill } from "../island/sessions";
import { SwipeAccumulator, dragDirection, slideDirection, stepFocus } from "./carousel";

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

function btn(
  label: string,
  kind: "primary" | "secondary",
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

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  // The overview's pager: one dot per pill, the active one named.
  const pager = h("div", { class: "pager" });
  let pagerKey = "";
  const BADGE_RING: Record<string, string> = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" };

  function syncPager() {
    const tasks = State.visibleTasks;
    const focus = State.focusTask?.id ?? "";
    const show = State.view === "overview" && tasks.length > 0;
    const key = show
      ? `${focus}|${tasks.map((t) => `${t.id}:${t.color}:${t.name}:${t.pillBadge ?? ""}`).join(",")}`
      : "";
    if (key === pagerKey) return;
    pagerKey = key;
    clear(pager);
    if (!show) return;
    for (const t of tasks) {
      const active = t.id === focus;
      const d = h("button", {
        class: active ? "pager-dot on" : "pager-dot",
        title: t.id === "integration_claude" ? "VS Code" : t.name,
        onclick: () => {
          if (!active) actions.setFocus(t.id);
        },
      });
      d.style.setProperty("--dot", t.color);
      if (t.pillBadge) d.style.setProperty("--ring", BADGE_RING[t.pillBadge]);
      pager.append(d);
      if (active) {
        pager.append(h("span", { class: "pager-label", text: t.id === "integration_claude" ? "VS Code" : t.name }));
      }
    }
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop),
    pager,
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      syncPager();
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  // One pill at a time, full width; the dots in the header say which, and a
  // swipe moves to the next (views/carousel.ts).
  const slot = h("div", { class: "left" }, left);
  const el = h("div", { class: "view overview" }, slot);

  const ids = () => State.visibleTasks.map((t) => t.id);
  const go = (dir: -1 | 1) => {
    const next = stepFocus(ids(), State.focusTask?.id ?? null, dir);
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

  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    busy: () => mode === "ticker" && ticker.animating,
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        // Slide the new pill in from the side the dots say it lives on.
        const dir = slideDirection(ids(), lastFocus, task?.id ?? null);
        if (dir !== 0) {
          slot.classList.remove("slide-next", "slide-prev");
          void slot.offsetWidth; // restart the animation
          slot.classList.add(dir > 0 ? "slide-next" : "slide-prev");
        }
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // VS Code with a live Claude Code session keeps the ticker; every other
      // pill shows its own card, exactly like IntegrationCardView.
      // A session pill always shows its ticker: it exists because a session does.
      const sessionActive =
        task != null &&
        (isSessionPill(task.id) ||
          (task.id === "integration_claude" && (task.state !== "idle" || task.steps.length > 0)));

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
        );
        // A session pill is Claude Code by definition: its context and cost
        // (from the statusline's status file) say more than the tool name.
        const usage = [
          task.ctxPct != null ? `ctx ${Math.round(task.ctxPct)}%` : "",
          task.costUsd != null ? `$${task.costUsd.toFixed(2)}` : "",
        ].filter(Boolean);
        const label = usage.length
          ? usage.join(" · ")
          : task.source === "claudeCode" ? "Claude Code" : "n8n";
        who.append(h("span", { class: "tool", text: label }));
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";
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
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
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

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
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
