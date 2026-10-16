// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { buildFileDiff, fileName, makeDiffStep, toOneLine } from "../core/diff";
import type { IslandViewName } from "../core/layout";
import { Sound } from "../core/sound";
import { sessionDiffs } from "../core/sessionDiffs";
import { State, type ApprovalInfo } from "../core/state";
import type { Island } from "./island";
import { parseQuestions } from "./askQuestion";
import { isSessionPill, resolvesCard, routeHook } from "./sessions";

const CLAUDE_ID = "integration_claude";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  /** Stop: Claude's final answer of the turn (Markdown). */
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Set by the relay when an edit was too big to forward whole (> 256 KB). */
  coucou_diff_truncated?: boolean;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
  /** "ask_user_question" when the relay's --ask hook waits for answers. */
  coucou_kind?: string;
}

/** Clears the question card if no answer was given before the hook gave up. */
let questionTimeout: number | null = null;

/** The return to idle that Stop arms, per pill, so the next turn can cancel it. */
const stopTimers = new Map<string, number>();

/**
 * Events that start new work on a pill (upstream 3491a2b): the timer the last
 * Stop armed would otherwise put it back to idle over the new state.
 */
const SUPERSEDES_STOP: ReadonlySet<string> = new Set([
  "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "StopFailure", "PermissionRequest",
]);

function cancelStopTimer(id: string): boolean {
  const timer = stopTimers.get(id);
  if (timer == null) return false;
  window.clearTimeout(timer);
  stopTimers.delete(id);
  return true;
}

/** A newer state replaces `finished`; the badge that timer was going to clear goes now. */
function supersedeStop(id: string) {
  if (cancelStopTimer(id)) State.setPillBadge(id, null);
}

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "VS Code";
  t.pillBadge = null;
  t.finalLine = null;
}

/** The final message stays on the card until the next turn starts. */
function clearFinalLine(id: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (t) t.finalLine = null;
}

/**
 * PostToolUse of Edit / MultiEdit / Write: a diff stored for the pill and a
 * step with its +N −M counts. Nothing is kept for a pill that does not exist,
 * so a stray event cannot grow memory. An edit the relay had to cut would give
 * wrong counts: the PreToolUse step ("Modifie · file") stands alone.
 */
function recordDiff(agentId: string, payload: HookPayload) {
  if (payload.coucou_diff_truncated) return;
  if (!State.tasks.some((t) => t.id === agentId)) return;
  const diff = buildFileDiff(payload.tool_name ?? "", payload.tool_input ?? {});
  if (!diff) return;
  const id = sessionDiffs.append(agentId, diff);
  State.appendStep(agentId, makeDiffStep(fileName(diff.path), diff.added, diff.removed, id));
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  // The relay hung up: the terminal answered first and Claude Code aborted it.
  void onEvent<{ request_id: string }>("hook-gone", ({ request_id }) =>
    dismissCard(island, (card) => card.requestId === request_id),
  );
}

/**
 * Takes down an approval, plan or question card that was answered elsewhere
 * (in the terminal), without sending any decision. `matches` picks the card.
 */
function dismissCard(
  island: Island,
  matches: (card: { requestId: string; taskId: string }) => boolean,
) {
  const card = State.pendingApproval ?? State.pendingQuestion;
  if (!card || !matches(card)) return;
  if (State.pendingApproval) {
    if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
    pendingTimeout = null;
  } else if (questionTimeout != null) {
    window.clearTimeout(questionTimeout);
    questionTimeout = null;
  }
  State.pendingApproval = null;
  State.pendingQuestion = null;
  State.isPinned = false;
  island.dropPin();
  State.updateTask(card.taskId, "working");
  State.setPillBadge(card.taskId, null);
  island.returnFocusAfterCard();
  if (State.view === "approval" || State.view === "plan" || State.view === "question") {
    island.setView(State.defaultView());
  }
  State.notify();
}


/** What every event handler knows about the event it handles. */
interface HookCtx {
  island: Island;
  payload: HookPayload;
  agentId: string;
  isExternalAgent: boolean;
  isSession: boolean;
  /** The event's pill has the focus. */
  focused: boolean;
  /** Alerts force the island open; work events only reveal the compact island. */
  surface(view: IslandViewName, isAlert: boolean): void;
  /** Ensure the pill exists and is up to date (name, cwd, activity). */
  ensurePill(): void;
}

function hookContext(island: Island, payload: HookPayload): HookCtx {
  const cwd = payload.cwd ?? "";
  const projectName = aliasProjectName(lastPathComponent(cwd) || "Session");
  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved. Claude Code events get one pill per session; only a
  // payload without a session id falls back to the catch-all Claude Code pill.
  const validAgent = validateAgent(payload.coucou_agent);
  const sessionId = payload.session_id ?? "";
  const agentId = routeHook(validAgent, sessionId);
  const isSession = isSessionPill(agentId);
  return {
    island, payload, agentId, isSession,
    isExternalAgent: validAgent !== null,
    focused: State.focusTask?.id === agentId,
    surface: (view, isAlert) => surfaceIsland(island, view, isAlert),
    ensurePill: () => {
      if (validAgent !== null) State.upsertExternalAgent(agentId, validAgent, agentColor(validAgent));
      else if (isSession) State.upsertSession(agentId, sessionId, projectName, cwd);
      else upsert(projectName, cwd);
    },
  };
}

function surfaceIsland(island: Island, view: IslandViewName, isAlert: boolean) {
  if (State.mode === "expanded") {
    if (isAlert) island.setView(view);
  } else if (isAlert) {
    island.alert(view);
  } else if (State.mode === "hidden") {
    island.reveal();
  }
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }
  const name = payload.hook_event_name ?? "";
  const ctx = hookContext(island, payload);
  // Every Claude Code event keeps its session pill alive and in order, except
  // the end of the session itself.
  if (ctx.isSession && name !== "SessionEnd") ctx.ensurePill();
  State.sweepSessions();

  // Backstop for the terminal answering first when the relay's hang-up was
  // missed: the session carrying on means its card is no longer waiting.
  const cardTool = State.pendingApproval?.tool ?? (State.pendingQuestion ? "AskUserQuestion" : "");
  if (cardTool && resolvesCard(name, payload.tool_name, cardTool)) {
    dismissCard(island, (card) => card.taskId === ctx.agentId);
  }
  if (SUPERSEDES_STOP.has(name)) supersedeStop(ctx.agentId);

  HOOK_HANDLERS[name]?.(ctx);
  State.notify();
}

function onSessionStart(c: HookCtx) {
  c.ensurePill();
  clearFinalLine(c.agentId);
  c.surface("overview", false);
  Sound.play("work");
}

function onPromptSubmit(c: HookCtx) {
  c.ensurePill();
  clearFinalLine(c.agentId);
  State.updateTask(c.agentId, "thinking");
  // The field is `prompt`; reading `message` meant this step was always blank.
  const asked = c.payload.prompt ?? c.payload.message;
  if (asked) State.appendStep(c.agentId, asked.slice(0, 60));
  c.surface("overview", false);
}

function onPreToolUse(c: HookCtx) {
  if (c.payload.coucou_kind === "ask_user_question") {
    showQuestion(c);
    return;
  }
  c.ensurePill();
  const tool = c.payload.tool_name ?? "Tool";
  // The waiting --ask copy of this event owns AskUserQuestion's card; the
  // plain one only marks the task, without a step that says nothing.
  if (tool === "AskUserQuestion") {
    State.updateTask(c.agentId, "question");
    return;
  }
  clearFinalLine(c.agentId);
  State.setToolKind(c.agentId, tool);
  State.updateTask(c.agentId, "working");
  State.appendStep(c.agentId, stepLabel(tool, c.payload.tool_input ?? {}));
  c.surface("overview", false);
}

function onNotification(c: HookCtx) {
  const message = c.payload.message ?? "";
  const lower = message.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("limite d")) {
    supersedeStop(c.agentId);
    State.updateTask(c.agentId, "ratelimit");
    Sound.play("rate");
  } else if (message.endsWith("?")) {
    supersedeStop(c.agentId);
    State.updateTask(c.agentId, "question");
    State.appendStep(c.agentId, message);
  }
}

/** How long a finished session shows as done before it goes idle (or away). */
const FINISHED_MS = 5200;
/** How long an ended session's pill stays before it is removed. */
const SESSION_END_MS = 5000;

function onStop(c: HookCtx) {
  const { agentId } = c;
  State.updateTask(agentId, "finished");
  // Claude Code puts the turn's answer in the Stop payload itself, so there is
  // no transcript to read (the relay does not even forward its path).
  const finalText = toOneLine(c.payload.last_assistant_message ?? c.payload.message ?? "");
  if (finalText) {
    State.appendStep(agentId, finalText);
    const t = State.tasks.find((x) => x.id === agentId);
    if (t) t.finalLine = finalText;
  }
  Sound.play("finish");
  if (c.focused) c.surface("finished", true);
  else State.setPillBadge(agentId, "finished");
  cancelStopTimer(agentId);
  stopTimers.set(agentId, window.setTimeout(() => {
    stopTimers.delete(agentId);
    if (c.isExternalAgent) {
      State.removeTask(agentId);
    } else {
      State.updateTask(agentId, "idle");
      State.setPillBadge(agentId, null);
    }
  }, FINISHED_MS));
}

function onStopFailure(c: HookCtx) {
  State.updateTask(c.agentId, "error");
  Sound.play("error");
  if (c.focused) c.surface("error", true);
  else State.setPillBadge(c.agentId, "error");
}

function onSessionEnd(c: HookCtx) {
  const { agentId } = c;
  // Nothing left for the timer to do, and it must not outlive the session: a
  // pill recreated within 5.2 s would be removed by it.
  cancelStopTimer(agentId);
  sessionDiffs.clear(agentId);
  if (c.isExternalAgent) {
    State.removeTask(agentId);
  } else if (c.isSession) {
    // A moment to see it end; a session resumed meanwhile keeps its pill.
    State.updateTask(agentId, "idle");
    const endedAt = performance.now();
    window.setTimeout(() => {
      const t = State.tasks.find((x) => x.id === agentId);
      if (t && (t.lastEventAt ?? 0) <= endedAt) State.removeTask(agentId);
    }, SESSION_END_MS);
  } else {
    State.updateTask(agentId, "idle");
    clearSession();
  }
}

/** How long Coucou keeps a card up: the relay stops waiting at 110 s. */
const CARD_TIMEOUT_MS = 110_000;

function onPermissionRequest(c: HookCtx) {
  const requestId = c.payload.request_id ?? "";
  // External agents do not get an approval card: showing one would look like
  // a Claude Code request. Decline immediately so the agent re-asks in its
  // terminal.
  if (c.isExternalAgent) {
    if (requestId) void Bridge.approvalDecline(requestId);
    return;
  }
  // AskUserQuestion: the terminal shows its dialog at the same moment, and
  // the card answers it too (the relay hands the answers back as
  // updatedInput). Whichever is answered first wins; the other goes away.
  if ((c.payload.tool_name ?? "Tool") === "AskUserQuestion") {
    showQuestion(c);
    return;
  }
  // One card, one request. A second one must never quietly replace the first:
  // that would leave a human staring at request B while request A waits for
  // a decision nobody can give. Hand it straight back to the terminal.
  const busy = (State.pendingApproval && State.pendingApproval.requestId !== requestId) || State.pendingQuestion;
  if (busy) {
    if (requestId) void Bridge.approvalDecline(requestId);
    return;
  }
  c.ensurePill();
  showApproval(c, approvalInfo(c));
}

function approvalInfo(c: HookCtx): ApprovalInfo {
  const tool = c.payload.tool_name ?? "Tool";
  const input = c.payload.tool_input ?? {};
  const isPlan = tool === "ExitPlanMode";
  return {
    requestId: c.payload.request_id ?? "",
    sessionId: c.payload.session_id ?? "",
    taskId: c.agentId,
    tool,
    command: approvalTarget(tool, input),
    kind: isPlan ? "plan" : "tool",
    plan: isPlan && typeof input.plan === "string" ? input.plan : undefined,
    planFilePath: isPlan && typeof input.planFilePath === "string" ? input.planFilePath : undefined,
  };
}

function showApproval(c: HookCtx, approval: ApprovalInfo) {
  const { island, agentId } = c;
  if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
  State.pendingApproval = approval;
  // The relay's short ack window closes in 800 ms; everything below this
  // line is synchronous, so the card really is up by the time it lands.
  if (approval.requestId) void Bridge.approvalAck(approval.requestId);
  State.updateTask(agentId, "approval");
  State.isPinned = true;
  Sound.play("approval");
  // The session that asks takes the focus: with one pill per session, a
  // badge on a pill would leave the card naming the wrong project. The pill
  // it interrupted gets the focus back once the card is answered.
  island.focusForCard(agentId);
  island.alert(approval.kind === "plan" ? "plan" : "approval");
  // Coucou answers within 108 s or not at all; after that the terminal has
  // taken over and the card would be lying.
  pendingTimeout = window.setTimeout(() => {
    pendingTimeout = null;
    if (!State.pendingApproval) return;
    State.pendingApproval = null;
    expireCard(island, agentId, ["approval", "plan"]);
  }, CARD_TIMEOUT_MS);
}

/** A card the terminal took over: unpin, give the focus back, leave its view. */
function expireCard(island: Island, taskId: string, views: IslandViewName[]) {
  State.isPinned = false;
  island.dropPin();
  State.updateTask(taskId, "working");
  State.setPillBadge(taskId, null);
  island.returnFocusAfterCard();
  if (views.includes(State.view)) island.setView(State.defaultView());
  State.notify();
}

/** Each event a handler; anything else only keeps the pill alive. */
const HOOK_HANDLERS: Record<string, (c: HookCtx) => void> = {
  SessionStart: onSessionStart,
  UserPromptSubmit: onPromptSubmit,
  PreToolUse: onPreToolUse,
  PostToolUse: (c) => {
    State.updateTask(c.agentId, "working");
    recordDiff(c.agentId, c.payload);
  },
  PostToolUseFailure: (c) => {
    State.updateTask(c.agentId, "working");
    State.appendStep(c.agentId, "⚠ failed");
  },
  Notification: onNotification,
  Stop: onStop,
  StopFailure: onStopFailure,
  SessionEnd: onSessionEnd,
  SubagentStart: (c) => State.appendStep(c.agentId, "+ subagent"),
  SubagentStop: (c) => State.appendStep(c.agentId, "• subagent done"),
  PermissionRequest: onPermissionRequest,
};

/**
 * AskUserQuestion through the relay's --ask hook: the questions with their
 * options, answered from the island. Anything the card cannot carry goes
 * straight back to the terminal.
 */
function showQuestion(c: HookCtx) {
  const { island, payload, agentId: taskId } = c;
  const requestId = payload.request_id ?? "";
  const items = parseQuestions(payload.tool_input);
  const busy =
    State.pendingApproval != null ||
    (State.pendingQuestion != null && State.pendingQuestion.requestId !== requestId);
  if (c.isExternalAgent || !items || busy) {
    if (requestId) void Bridge.approvalDecline(requestId);
    return;
  }
  c.ensurePill();
  if (questionTimeout != null) window.clearTimeout(questionTimeout);
  State.pendingQuestion = { requestId, taskId, items, index: 0, answers: [] };
  // Same 800 ms ack window as a permission request.
  if (requestId) void Bridge.approvalAck(requestId);
  State.updateTask(taskId, "question");
  State.isPinned = true;
  Sound.play("question");
  // As with approvals: the session asking takes the focus, and gives it back.
  island.focusForCard(taskId);
  island.alert("question");
  // The relay stops waiting at 110 s; past that the terminal is asking.
  questionTimeout = window.setTimeout(() => {
    questionTimeout = null;
    if (State.pendingQuestion?.requestId !== requestId) return;
    State.pendingQuestion = null;
    expireCard(island, taskId, ["question"]);
  }, CARD_TIMEOUT_MS);
}
