// Where integration alerts land. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alertTarget } from "../src/island/quotaAlert.ts";

test("an alert goes to its own pill when it is on", () => {
  assert.equal(alertTarget("integration_quota", [{ id: "integration_quota" }, { id: "cc_1a2b3c4d" }]), "integration_quota");
  assert.equal(alertTarget("integration_messages", [{ id: "integration_messages" }]), "integration_messages");
});

test("with Claude usage off, its alert goes to the last active session", () => {
  const tasks = [
    { id: "integration_claude" },
    { id: "cc_aaaaaaaa", lastEventAt: 100 },
    { id: "cc_bbbbbbbb", lastEventAt: 900 },
    { id: "integration_space" },
  ];
  assert.equal(alertTarget("integration_quota", tasks), "cc_bbbbbbbb");
});

test("no session: the catch-all Claude Code pill, else nowhere", () => {
  assert.equal(alertTarget("integration_quota", [{ id: "integration_claude" }, { id: "integration_media" }]), "integration_claude");
  assert.equal(alertTarget("integration_quota", [{ id: "integration_media" }]), null);
});

test("another pill that is off has no alert", () => {
  assert.equal(alertTarget("integration_space", [{ id: "integration_claude" }, { id: "cc_aaaaaaaa" }]), null);
});
