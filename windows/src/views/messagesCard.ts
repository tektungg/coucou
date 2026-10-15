// The Messages card: one row per chat, newest chat first, like a chat app's
// inbox. A row opens its app (and leaves the card), ✓ marks it read without
// opening it, ⌄ shows every message of the chat. Chips narrow the card to one
// app when several are on it. The rules live in messageGroups.ts.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { arr, header } from "./integrations";
import {
  APP_COLORS, APP_NAMES, OTHER_COLOR, ExpandedSet, appCounts, avatarLetter, effectiveFilter, filterThreads,
  isFresh, messageLine, previewText, shortAgo, threadIds, threadsOf, type AppFilter, type MessageLike, type Thread,
} from "./messageGroups";

const PILL = "integration_messages";
const CARD_COLOR = "#5865F2";

/** Card state that outlives the rebuild on every poll. */
const expanded = new ExpandedSet<string>();
let filter: AppFilter = "all";
let scrollTop = 0;
let newestId: unknown = null;

const colorOf = (app: string) => APP_COLORS[app] ?? OTHER_COLOR;
const nameOf = (app: string) => APP_NAMES[app] ?? (app || "Other");

/** Opening a chat reads it: the app comes forward and the chat leaves the card. */
function openThread(t: Thread<MessageLike>) {
  void Bridge.openApp(t.app);
  dismiss(t);
}

function dismiss(t: Thread<MessageLike>) {
  const ids = threadIds(t);
  if (ids.length) void Bridge.dismissMessages(ids);
}

function iconButton(cls: string, title: string, icon: string, onClick: () => void): HTMLElement {
  const b = h("button", { class: `msg-act ${cls}`, title, "aria-label": title }, svg(icon, 10, { stroke: 2.6 }));
  b.addEventListener("click", (e) => {
    e.stopPropagation(); // the row's own click opens the app
    onClick();
  });
  return b;
}

function avatar(t: Thread<MessageLike>): HTMLElement {
  const el = h("span", { class: "msg-avatar", text: avatarLetter(t.title) }, h("i", { class: "msg-badge" }));
  el.style.setProperty("--app", colorOf(t.app));
  return el;
}

/** The chat's messages, oldest first like a conversation, each in full. */
function threadBody(t: Thread<MessageLike>): HTMLElement {
  const body = h("div", { class: "msg-thread" });
  for (const m of [...t.items].reverse()) {
    body.append(h("div", { class: "msg-line", text: messageLine(m, t.isGroup) }));
  }
  return body;
}

function chatRow(t: Thread<MessageLike>, arrived: boolean, refill: () => void): HTMLElement {
  const open = expanded.has(t.key);
  const time = h("span", { class: isFresh(t.latestAt) ? "msg-time fresh" : "msg-time", text: shortAgo(t.latestAt) });
  const actions = h(
    "span",
    { class: "msg-actions" },
    iconButton("read", "Mark as read", ICONS.check, () => dismiss(t)),
    iconButton("more", open ? "Show less" : "Show the whole chat", ICONS.chevronRight, () => {
      expanded.toggle(t.key);
      refill();
    }),
  );
  const top = h(
    "div",
    { class: "msg-top" },
    h("span", { class: "msg-title", text: t.title }),
    t.items.length > 1 ? h("span", { class: "msg-count", text: String(t.items.length) }) : null,
    time,
    actions,
  );
  const main = h("div", { class: "msg-main" }, top, open ? threadBody(t) : h("div", { class: "msg-preview", text: previewText(t) }));
  const row = h("div", { class: "msg-row", title: `${nameOf(t.app)} · ${t.title}` }, avatar(t), main);
  row.classList.toggle("expanded", open);
  row.classList.toggle("arrive", arrived);
  row.addEventListener("click", () => openThread(t));
  return row;
}

/** All · Telegram 2 · WhatsApp 1. Only worth the room when two apps or more are on the card. */
function chips(messages: MessageLike[], current: AppFilter, refill: () => void): HTMLElement | null {
  const counts = appCounts(messages);
  if (counts.length < 2) return null;
  const chip = (app: AppFilter, label: string, count: number) => {
    const b = h(
      "button",
      { class: app === current ? "msg-chip on" : "msg-chip", title: app === "all" ? "Every app" : `Only ${label}` },
      app === "all" ? null : h("i", { class: "msg-chip-dot" }),
      h("span", { text: label }),
      h("b", { text: String(count) }),
    );
    b.style.setProperty("--app", app === "all" ? "var(--acc)" : colorOf(app));
    b.addEventListener("click", () => {
      filter = app;
      refill();
    });
    return b;
  };
  const row = h("span", { class: "msg-chips" }, chip("all", "All", messages.length));
  for (const c of counts) row.append(chip(c.app, nameOf(c.app), c.count));
  return row;
}

export function messagesCard(): HTMLElement {
  const messages = arr(PILL, "messages") as MessageLike[];
  const threads = threadsOf(messages);
  expanded.keepOnly(threads.map((t) => t.key));
  // News: back to every app and to the top, so the glance shows the new message.
  const latest = messages[0]?.id ?? null;
  let arriving = latest !== newestId && newestId !== null;
  if (latest !== newestId) {
    newestId = latest;
    filter = "all";
    scrollTop = 0;
  }

  const right = h("span", { class: "int-head-right" });
  const list = h("div", { class: "msg-list" });
  const clearAll = h("button", {
    class: "int-clear",
    title: "Take every message off the card",
    text: "Clear all",
    onclick: () => void Bridge.dismissMessages(null),
  });
  const fill = () => {
    filter = effectiveFilter(filter, threads);
    clear(right);
    const c = chips(messages, filter, fill);
    if (c) right.append(c);
    right.append(clearAll);
    clear(list);
    filterThreads(threads, filter).forEach((t, i) => list.append(chatRow(t, arriving && i === 0, fill)));
    arriving = false; // slides in once, not again on a chip or expand click
  };
  fill();
  list.addEventListener("scroll", () => {
    scrollTop = list.scrollTop;
  }, { passive: true });
  // Not in the DOM yet: restore once it is laid out.
  requestAnimationFrame(() => {
    list.scrollTop = scrollTop;
  });
  return h("div", { class: "int-card msg-card" }, header(CARD_COLOR, "Messages", String(messages.length), right), list);
}
