// Home's session board (views/board.ts). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TILES, ago, sessionBoard, stateLabel, usageOf, type BoardSession } from "../src/views/board.ts";

const NOW = 10_000_000;
const s = (id: string, state: string, over: Partial<BoardSession> = {}): BoardSession => ({
  id, name: id, color: "#4F8EF7", state, steps: [], stepIndex: 0, lastEventAt: NOW - 3 * 60_000, ...over,
});

test("one tile per session, with the step it is on and how long ago", () => {
  const b = sessionBoard([s("coucou", "working", { steps: ["Reading", "Editing engine.ts"], stepIndex: 1 })], "coucou", NOW);
  assert.equal(b.tiles.length, 1);
  assert.deepEqual(b.tiles[0], {
    id: "coucou", name: "coucou", color: "#4F8EF7", line: "Editing engine.ts · 3 min", usage: null, mark: null, active: true,
  });
  assert.equal(b.more, null);
});

test("a step index past the end shows the last step", () => {
  const b = sessionBoard([s("a", "working", { steps: ["One", "Two"], stepIndex: 9 })], "a", NOW);
  assert.match(b.tiles[0].line, /^Two/);
});

test("states without a step show their label and mark", () => {
  const b = sessionBoard([s("d", "finished"), s("q", "question"), s("e", "error")], "d", NOW);
  const byId = Object.fromEntries(b.tiles.map((t) => [t.id, t]));
  assert.equal(byId.q.line, "has a question · 3 min");
  assert.equal(byId.q.mark, "ask");
  assert.equal(byId.e.mark, "error");
  assert.equal(byId.d.mark, "done");
  const idle = sessionBoard([s("i", "idle", { lastEventAt: undefined })], "i", NOW).tiles[0];
  assert.deepEqual([idle.line, idle.mark], ["idle", null], "no event yet, no time");
  assert.equal(stateLabel("idle"), "idle");
  assert.equal(stateLabel("dizzy"), "idle", "unknown states read as idle");
});

test("sessions that need you come first; ties keep their order", () => {
  const b = sessionBoard([s("done", "finished"), s("work", "working"), s("ask", "approval")], "done", NOW);
  assert.deepEqual(b.tiles.map((t) => t.id), ["ask", "work", "done"]);
});

test("past 3 sessions the last slot folds into +N, and the focus always stays", () => {
  const all = [s("a", "approval"), s("b", "working"), s("c", "working"), s("d", "finished"), s("e", "idle")];
  const b = sessionBoard(all, "e", NOW);
  assert.equal(b.tiles.length, MAX_TILES - 1);
  assert.ok(b.tiles.some((t) => t.id === "e" && t.active), "the focused session is shown");
  assert.equal(b.tiles[0].id, "a", "who needs you stays first");
  assert.equal(b.more?.count, all.length - b.tiles.length);
  assert.ok(b.more && !b.tiles.some((t) => t.id === b.more!.nextId));
});

test("exactly 3 sessions fit without +N", () => {
  const b = sessionBoard([s("a", "working"), s("b", "working"), s("c", "working")], "a", NOW);
  assert.equal(b.tiles.length, 3);
  assert.equal(b.more, null);
});

test("the bubble names two sessions, needs-you first, and sparkles when one is done", () => {
  const b = sessionBoard([s("venturo-api", "finished"), s("coucou", "working", { steps: ["Editing engine.ts"] })], "coucou", NOW);
  assert.equal(b.bubble, "coucou: Editing engine.ts · venturo-api is done ✨");
  const many = sessionBoard([s("a", "working"), s("b", "approval"), s("c", "idle")], "a", NOW);
  assert.equal(many.bubble, "b needs you · a is working · +1 more");
});

test("context and cost from the statusline ride on the tile", () => {
  assert.equal(usageOf({ ctxPct: 44.6, costUsd: 1.2 }), "ctx 45% · $1.20");
  assert.equal(usageOf({ costUsd: 0.5 }), "$0.50");
  assert.equal(usageOf({}), null);
  const b = sessionBoard([s("a", "working", { ctxPct: 10 })], "a", NOW);
  assert.equal(b.tiles[0].usage, "ctx 10%");
});

test("ago reads short", () => {
  assert.equal(ago(5_000), "now");
  assert.equal(ago(59_999), "now");
  assert.equal(ago(60_000), "1 min");
  assert.equal(ago(59 * 60_000), "59 min");
  assert.equal(ago(2 * 3_600_000), "2 h");
});

test("no sessions, an empty board", () => {
  assert.deepEqual(sessionBoard([], "x", NOW), { bubble: "No agent sessions right now.", tiles: [], more: null });
});
