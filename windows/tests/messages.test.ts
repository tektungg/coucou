// Messages card grouping and the auto-open rule. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByApp } from "../src/views/messageGroups.ts";
import { messageAlertAction, type MessageAlertContext } from "../src/island/messageAlert.ts";

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
