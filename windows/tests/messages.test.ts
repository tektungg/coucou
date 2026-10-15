// Messages card chats, filter, labels and the auto-open rule. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ExpandedSet, appCounts, avatarLetter, effectiveFilter, filterThreads, isFresh, messageLine, previewText, shortAgo,
  threadIds, threadKey, threadsOf,
} from "../src/views/messageGroups.ts";
import { MESSAGES_OVERVIEW_H, VIEW_LAYOUTS, islandSize } from "../src/core/layout.ts";
import { focusAfterGlance, messageAlertAction, rememberGlance, type MessageAlertContext } from "../src/island/messageAlert.ts";

// The shapes notify.rs parses toasts into (see its telegram_group / whatsapp tests).
const history = [
  { id: 6, app: "telegram", sender: "Budi", place: "Dev Squad", text: "udah merge", at: 6000 },
  { id: 5, app: "whatsapp", sender: "Mama", text: "pulang jam berapa?", at: 5000 },
  { id: 4, app: "discord", sender: "neko", place: "Tauri", channel: "#help", text: "pin it", at: 4000 },
  { id: 3, app: "telegram", sender: "Sari", place: "Dev Squad", text: "cek staging", at: 3000 },
  { id: 2, app: "whatsapp", sender: "Rani", text: "futsal?", at: 2000 },
  { id: 1, app: "whatsapp", sender: "Mama", text: "sudah makan?", at: 1000 },
];

test("messages fold into chats, the chat with the newest message first", () => {
  const threads = threadsOf(history);
  assert.deepEqual(threads.map((t) => t.title), ["Dev Squad", "Mama", "Tauri › #help", "Rani"]);
  assert.deepEqual(threads.map((t) => t.items.map((m) => m.id)), [[6, 3], [5, 1], [4], [2]]);
  assert.deepEqual(threads.map((t) => t.latestAt), [6000, 5000, 4000, 2000]);
  assert.deepEqual(threads.map((t) => t.isGroup), [true, false, true, false]);
  assert.deepEqual(threadIds(threads[1]), [5, 1]);
  assert.deepEqual(threadsOf([]), []);
});

test("a group is one chat whoever writes; a DM is one chat per sender and per app", () => {
  assert.equal(threadKey({ app: "telegram", sender: "Budi", place: "Dev Squad" }), threadKey({ app: "telegram", sender: "Sari", place: "Dev Squad" }));
  assert.notEqual(threadKey({ app: "whatsapp", sender: "Mama" }), threadKey({ app: "whatsapp", sender: "Rani" }));
  assert.notEqual(threadKey({ app: "whatsapp", sender: "Mama" }), threadKey({ app: "telegram", sender: "Mama" }));
  assert.notEqual(threadKey({ app: "discord", place: "Tauri", channel: "#help" }), threadKey({ app: "discord", place: "Tauri", channel: "#general" }));
  // A DM named like a group is still a DM: the place decides, not the name.
  assert.notEqual(threadKey({ app: "telegram", sender: "Dev Squad" }), threadKey({ app: "telegram", sender: "x", place: "Dev Squad" }));
});

test("a message with no app or sender still gets a row and a title", () => {
  const [t] = threadsOf([{ id: 1, text: "hi" }]);
  assert.equal(t.app, "");
  assert.equal(t.title, "Message");
  assert.equal(threadsOf([{ id: 1, app: "slack", text: "hi" }])[0].title, "Slack");
});

test("group lines say who wrote, DM lines do not, and a sender equal to the group is not repeated", () => {
  const threads = threadsOf(history);
  assert.equal(previewText(threads[0]), "Budi: udah merge");
  assert.equal(previewText(threads[1]), "pulang jam berapa?");
  assert.equal(messageLine({ sender: "Dev Squad", place: "Dev Squad", text: "Deploy jam 3" }, true), "Deploy jam 3");
  assert.equal(previewText(threadsOf([{ id: 1, app: "telegram", sender: "Ana", text: "line one\n  line two" }])[0]), "line one line two");
});

test("chips count messages per app, newest app first", () => {
  assert.deepEqual(appCounts(history), [
    { app: "telegram", count: 2 }, { app: "whatsapp", count: 3 }, { app: "discord", count: 1 },
  ]);
  assert.deepEqual(appCounts([]), []);
});

test("the filter narrows to one app and falls back to all once that app is gone", () => {
  const threads = threadsOf(history);
  assert.deepEqual(filterThreads(threads, "whatsapp").map((t) => t.title), ["Mama", "Rani"]);
  assert.equal(filterThreads(threads, "all").length, 4);
  assert.equal(effectiveFilter("slack", threads), "all", "no Slack message left on the card");
  assert.equal(filterThreads(threads, "slack").length, 4);
  assert.equal(effectiveFilter("discord", threads), "discord");
});

test("the avatar letter is the first whole character, upper case", () => {
  assert.equal(avatarLetter("mama"), "M");
  assert.equal(avatarLetter("  dev squad"), "D");
  assert.equal(avatarLetter("ダーリン"), "ダ");
  assert.equal(avatarLetter("👨‍👩‍👧 Family"), "👨‍👩‍👧", "a joined emoji stays whole");
  assert.equal(avatarLetter("#general"), "#");
  assert.equal(avatarLetter(""), "?");
  assert.equal(avatarLetter("   "), "?");
});

test("times are short: now, minutes, hours, days", () => {
  const now = 10 * 86_400_000;
  assert.equal(shortAgo(now - 20_000, now), "now");
  assert.equal(shortAgo(now + 5_000, now), "now", "a toast stamped slightly ahead is not negative");
  assert.equal(shortAgo(now - 5 * 60_000, now), "5m");
  assert.equal(shortAgo(now - 2 * 3_600_000, now), "2h");
  assert.equal(shortAgo(now - 3 * 86_400_000, now), "3d");
  assert.equal(isFresh(now - 59_000, now), true);
  assert.equal(isFresh(now - 61_000, now), false);
});

test("the island grows only for the Messages card", () => {
  assert.equal(islandSize("expanded", "overview", 0, undefined, true).h, MESSAGES_OVERVIEW_H);
  assert.equal(islandSize("expanded", "overview").h, VIEW_LAYOUTS.overview.height);
  assert.ok(MESSAGES_OVERVIEW_H > VIEW_LAYOUTS.overview.height);
  // Only the overview: an approval or the chat keeps its own height.
  assert.equal(islandSize("expanded", "approval", 0, undefined, true).h, VIEW_LAYOUTS.approval.height);
  assert.equal(islandSize("compact", "overview", 0, undefined, true).h, islandSize("compact", "overview").h);
  assert.equal(islandSize("hidden", "overview", 0, undefined, true).h, 0);
});

const closed: MessageAlertContext = {
  mode: "hidden", view: "overview", pinned: false, waiting: false, pointerInIsland: false, fullscreen: false,
};

test("a closed or compact island opens on the message", () => {
  assert.equal(messageAlertAction(closed), "open");
  assert.equal(messageAlertAction({ ...closed, mode: "compact" }), "open");
});

test("an open overview only switches to the Messages pill", () => {
  assert.equal(messageAlertAction({ ...closed, mode: "expanded" }), "focus");
});

test("never steals the island from an approval, the chat or the user's pointer", () => {
  assert.equal(messageAlertAction({ ...closed, waiting: true }), "none");
  assert.equal(messageAlertAction({ ...closed, pinned: true }), "none");
  assert.equal(messageAlertAction({ ...closed, pointerInIsland: true }), "none");
  assert.equal(messageAlertAction({ ...closed, mode: "compact", pointerInIsland: true }), "none");
  assert.equal(messageAlertAction({ ...closed, mode: "expanded", view: "prompt" }), "none");
  assert.equal(messageAlertAction({ ...closed, mode: "expanded", view: "approval" }), "none");
});

test("a fullscreen game or film is never interrupted", () => {
  assert.equal(messageAlertAction({ ...closed, fullscreen: true }), "none");
  assert.equal(messageAlertAction({ ...closed, mode: "compact", fullscreen: true }), "none");
  assert.equal(messageAlertAction({ ...closed, mode: "expanded", fullscreen: true }), "none");
});

test("expanded chats toggle and forget the ones that left the card", () => {
  const e = new ExpandedSet<string>();
  assert.equal(e.toggle("a"), true);
  assert.equal(e.toggle("b"), true);
  assert.equal(e.has("a"), true);
  assert.equal(e.toggle("a"), false, "a second click collapses");
  assert.equal(e.has("a"), false);
  e.keepOnly(["c", "d"]);
  assert.equal(e.size, 0, "chat b was read, so its state goes too");
});

test("a message's glance remembers the pill it came from", () => {
  assert.deepEqual(rememberGlance(null, "integration_media", "integration_messages"), {
    to: "integration_media", from: "integration_messages",
  });
  // A second message during the glance keeps the first pill.
  const first = { to: "integration_media", from: "integration_messages" };
  assert.equal(rememberGlance(first, "integration_messages", "integration_messages"), first);
  // Already on Messages, or nothing focused: nothing to give back.
  assert.equal(rememberGlance(null, "integration_messages", "integration_messages"), null);
  assert.equal(rememberGlance(null, null, "integration_messages"), null);
});

test("closing after the glance goes back to that pill", () => {
  const glance = { to: "integration_media", from: "integration_messages" };
  const visible = ["integration_media", "integration_messages", "integration_space"];
  assert.equal(focusAfterGlance(glance, "integration_messages", visible), "integration_media");
});

test("a pill the user picked during the glance stays", () => {
  const glance = { to: "integration_media", from: "integration_messages" };
  const visible = ["integration_media", "integration_messages", "integration_space"];
  assert.equal(focusAfterGlance(glance, "integration_space", visible), null);
  assert.equal(focusAfterGlance(null, "integration_messages", visible), null);
});

test("a pill that is gone is not brought back", () => {
  const glance = { to: "cc_1234abcd", from: "integration_messages" };
  assert.equal(focusAfterGlance(glance, "integration_messages", ["integration_messages"]), null);
});

// Island.focusForCard / returnFocusAfterCard run a Claude Code card through the
// same two functions, with the asking session's pill as `from`.

test("answering a card gives Music its focus back", () => {
  const visible = ["integration_media", "cc_1234abcd"];
  const card = rememberGlance(null, "integration_media", "cc_1234abcd");
  assert.deepEqual(card, { to: "integration_media", from: "cc_1234abcd" });
  assert.equal(focusAfterGlance(card, "cc_1234abcd", visible), "integration_media");
});

test("a card from the session already in focus has nothing to give back", () => {
  assert.equal(rememberGlance(null, "cc_1234abcd", "cc_1234abcd"), null);
});

test("the same card re-sent keeps the pill it first interrupted", () => {
  const card = { to: "integration_media", from: "cc_1234abcd" };
  assert.equal(rememberGlance(card, "cc_1234abcd", "cc_1234abcd"), card);
});

test("a card during a message's glance hands back to Messages, then Music", () => {
  const visible = ["integration_media", "integration_messages", "cc_1234abcd"];
  const message = rememberGlance(null, "integration_media", "integration_messages");
  const card = rememberGlance(null, "integration_messages", "cc_1234abcd");
  // Card answered: back on Messages, so the message's glance still matches…
  assert.equal(focusAfterGlance(card, "cc_1234abcd", visible), "integration_messages");
  // …and the island closing then returns to Music.
  assert.equal(focusAfterGlance(message, "integration_messages", visible), "integration_media");
});
