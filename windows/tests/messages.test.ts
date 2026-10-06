// Messages card grouping and the auto-open rule. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByApp } from "../src/views/messageGroups.ts";
import { focusAfterGlance, messageAlertAction, rememberGlance, type MessageAlertContext } from "../src/island/messageAlert.ts";

test("messages are grouped by app, the app with the newest message first", () => {
  const history = [
    { id: 5, app: "slack" },
    { id: 4, app: "discord" },
    { id: 3, app: "slack" },
    { id: 2, app: "whatsapp" },
    { id: 1, app: "discord" },
  ];
  const groups = groupByApp(history);
  assert.deepEqual(groups.map((g) => g.app), ["slack", "discord", "whatsapp"]);
  assert.deepEqual(groups.map((g) => g.items.map((m) => m.id)), [[5, 3], [4, 1], [2]]);
});

test("a message without an app gets its own group, nothing is dropped", () => {
  const groups = groupByApp([{ app: "telegram" }, {}, { app: 7 }]);
  assert.deepEqual(groups.map((g) => [g.app, g.items.length]), [["telegram", 1], ["", 2]]);
  assert.deepEqual(groupByApp([]), []);
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

test("expanded messages toggle and forget the ones that left the card", async () => {
  const { ExpandedMessages } = await import("../src/views/messageGroups.ts");
  const e = new ExpandedMessages();
  assert.equal(e.toggle(1), true);
  assert.equal(e.toggle(2), true);
  assert.equal(e.has(1), true);
  assert.equal(e.toggle(1), false, "a second click collapses");
  assert.equal(e.has(1), false);
  e.keepOnly([3, 4]);
  assert.equal(e.size, 0, "message 2 was cleared, so its state goes too");
});

test("the chevron shows for long or multi-line messages only", async () => {
  const { needsExpander } = await import("../src/views/messageGroups.ts");
  assert.equal(needsExpander("oke", false), false);
  assert.equal(needsExpander("a long line cut by the card", true), true);
  assert.equal(needsExpander("line one\nline two", false), true);
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
