// Cards for this build's own pills: Claude usage, Space, music, messages.
// Kept out of integrations.ts so the stock cards stay as upstream ships them.

import { h, svg, dot } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";
import { arr, get, header, listRow, timeAgo } from "./integrations";
import { sortSpaceItems } from "./spaceTasks";
import { groupByApp, type MessageGroup } from "./messageGroups";

export const PERSONAL_IDS = new Set([
  "integration_quota", "integration_space", "integration_media", "integration_messages",
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

function mediaCard(): HTMLElement {
  const d = get("integration_media");
  const playing = d.playing === true;
  // Paths, not ⏮ ⏯ ⏭: Windows draws those as coloured emoji tiles.
  const button = (path: string, title: string, action: string, enabled: boolean) => {
    const b = h(
      "button",
      {
        class: "media-btn",
        title,
        onclick: () => {
          if (enabled) void Bridge.mediaControl(action);
        },
      },
      svg(path, 10),
    );
    if (!enabled) b.style.opacity = "0.35";
    return b;
  };
  return h(
    "div",
    { class: "int-card" },
    header("#1DB954", "Music", str(d.app) || "Now playing"),
    h(
      "div",
      { class: "media-body" },
      h("div", { class: "media-title", text: str(d.title) }),
      h("div", { class: "int-sub", text: str(d.artist) }),
      h(
        "div",
        { class: "media-controls" },
        button(MEDIA_ICONS.prev, "Previous", "prev", d.canPrev === true),
        button(playing ? MEDIA_ICONS.pause : MEDIA_ICONS.play, playing ? "Pause" : "Play", "play_pause", d.canPlayPause !== false),
        button(MEDIA_ICONS.next, "Next", "next", d.canNext === true),
      ),
    ),
  );
}

// ── Messages ──────────────────────────────────────────────────────────────────

/** "Server › #channel", "Workspace › #channel", "#channel", or "" for a DM. */
export function messagePlace(m: { place?: unknown; channel?: unknown }): string {
  return [str(m.place), str(m.channel)].filter(Boolean).join(" › ");
}

function messageRow(m: Record<string, unknown>, first: boolean, full: boolean): HTMLElement {
  const app = str(m.app);
  const place = messagePlace(m);
  const cells: Node[] = [
    h("span", { class: "int-name", text: str(m.sender) || APP_NAMES[app] || "Message" }),
    h("span", { class: "int-ago", text: timeAgo(num(m.at) ?? Date.now()) }),
  ];
  const line = `${place ? `${place}: ` : ""}${str(m.text)}`;
  if (first || full) cells.push(h("span", { class: full ? "int-sub wrap" : "int-sub", text: line }));
  const row = listRow(APP_COLORS[app] ?? "#8e939c", first, ...cells);
  row.title = `${APP_NAMES[app] ?? app}${place ? ` · ${place}` : ""}`;
  row.addEventListener("click", () => {
    void Bridge.openApp(app);
  });
  return row;
}

/** One line per message under its app's heading: sender, text, age. */
function groupedMessageRow(m: Record<string, unknown>, newest: boolean): HTMLElement {
  const app = str(m.app);
  const place = messagePlace(m);
  const row = h(
    "div",
    { class: newest ? "int-row msg-row newest" : "int-row msg-row" },
    h("span", { class: "int-name", text: str(m.sender) || APP_NAMES[app] || "Message" }),
    h("span", { class: "int-sub", text: `${place ? `${place}: ` : ""}${str(m.text)}` }),
    h("span", { class: "int-ago", text: timeAgo(num(m.at) ?? Date.now()) }),
  );
  if (newest) row.style.background = `${APP_COLORS[app] ?? "#8e939c"}1f`;
  row.title = `${APP_NAMES[app] ?? app}${place ? ` · ${place}` : ""}`;
  row.addEventListener("click", () => {
    void Bridge.openApp(app);
  });
  return row;
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
  head.addEventListener("click", () => {
    void Bridge.openApp(group.app);
  });
  return head;
}

/** The card is rebuilt on every poll: keep the list where the user left it, back to the top for news. */
let msgScrollTop = 0;
let msgNewestId: unknown = null;

function messagesCard(onDetail: () => void): HTMLElement {
  const messages = arr("integration_messages", "messages");
  const more = h("button", { class: "int-more", title: "All messages", onclick: onDetail }, svg(ICONS.ellipsis, 8));
  const list = h("div", { class: "int-rows msg-list" });
  for (const g of groupByApp(messages)) {
    list.append(groupHead(g));
    for (const m of g.items) list.append(groupedMessageRow(m, m === messages[0]));
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
  return h("div", { class: "int-card" }, header("#5865F2", "Messages", `${messages.length} recent`, more), list);
}

function messagesDetail(onBack: () => void): HTMLElement {
  const messages = arr("integration_messages", "messages");
  const list = h("div", { class: "int-rows scroll msg-detail" });
  for (const g of groupByApp(messages)) {
    list.append(groupHead(g));
    g.items.forEach((m) => list.append(messageRow(m, m === messages[0], true)));
  }
  return detailFrame("#5865F2", "Messages", onBack, list);
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
      return mediaCard();
    case "integration_messages":
      return detailOpen ? messagesDetail(closeDetail) : messagesCard(openDetail);
    default:
      return null;
  }
}
