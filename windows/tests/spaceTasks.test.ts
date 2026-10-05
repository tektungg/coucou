// Space card task order. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sortSpaceItems } from "../src/views/spaceTasks.ts";

test("open tasks come before done ones", () => {
  const items = [
    { name: "Daily Standup", done: true },
    { name: "Production Test", done: false },
    { name: "Retro", done: true },
    { name: "Feature", done: false },
  ];
  assert.deepEqual(sortSpaceItems(items).map((i) => i.name), ["Production Test", "Feature", "Daily Standup", "Retro"]);
});

test("Space's order is kept inside each group", () => {
  const items = [{ n: 1, done: false }, { n: 2, done: false }, { n: 3, done: true }, { n: 4, done: true }];
  assert.deepEqual(sortSpaceItems(items).map((i) => i.n), [1, 2, 3, 4]);
});

test("a missing or non-boolean done counts as open", () => {
  const items = [{ n: 1, done: true }, { n: 2 }, { n: 3, done: "true" }];
  assert.deepEqual(sortSpaceItems(items).map((i) => i.n), [2, 3, 1]);
});

test("the input is left untouched", () => {
  const items = [{ done: true }, { done: false }];
  const copy = structuredClone(items);
  sortSpaceItems(items);
  assert.deepEqual(items, copy);
  assert.deepEqual(sortSpaceItems([]), []);
});
