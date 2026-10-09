// The header's pill chips (views/pager.ts). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHIP_GAP, CHIP_W, LABEL_MAX_W, PAGER_MAX_W, labelWidth, pagerChips, pillLabel, type PagerPill,
} from "../src/views/pager.ts";

const pill = (id: string, name = id): PagerPill => ({ id, name });
const pills = (n: number) => Array.from({ length: n }, (_, i) => pill(`p${i}`, `Pill ${i}`));
const stripWidth = (shown: number, overflow: boolean, label: string) =>
  (shown + (overflow ? 1 : 0)) * CHIP_W + (shown + (overflow ? 1 : 0) - 1) * CHIP_GAP + labelWidth(label);

test("every pill gets a chip; only the active one is named", () => {
  const out = pagerChips([pill("a", "Messages"), pill("b", "Music"), pill("c", "Space")], "b");
  assert.deepEqual(out.chips.map((c) => c.id), ["a", "b", "c"]);
  assert.deepEqual(out.chips.map((c) => c.label), [null, "Music", null]);
  assert.equal(out.overflow, null);
});

test("the Claude Code catch-all is named VS Code, like the old pager", () => {
  assert.equal(pillLabel(pill("integration_claude", "Claude Code")), "VS Code");
  assert.equal(pagerChips([pill("integration_claude", "Claude Code")], "integration_claude").chips[0].label, "VS Code");
});

test("an unknown focus falls back to the first pill", () => {
  const out = pagerChips(pills(3), "gone");
  assert.equal(out.chips[0].label, "Pill 0");
});

test("badges ride along on their chip", () => {
  const out = pagerChips([{ id: "a", name: "A", badge: "approval" }, pill("b")], "b");
  assert.equal(out.chips[0].badge, "approval");
  assert.equal(out.chips[1].badge, null);
});

test("too many pills fold into +N, keeping the active one and its neighbours", () => {
  const all = pills(16);
  const out = pagerChips(all, "p8");
  assert.ok(out.overflow, "16 pills cannot fit the strip");
  assert.ok(out.chips.some((c) => c.id === "p8" && c.label === "Pill 8"));
  assert.ok(out.chips.some((c) => c.id === "p7") && out.chips.some((c) => c.id === "p9"), "neighbours stay");
  assert.equal(out.chips.length + out.overflow.count, all.length, "every pill is either shown or counted");
  assert.ok(stripWidth(out.chips.length, true, "Pill 8") <= PAGER_MAX_W, "the strip fits");
  // The +N chip opens the first hidden pill after the active one.
  const shown = new Set(out.chips.map((c) => c.id));
  assert.ok(!shown.has(out.overflow.nextId));
  assert.ok(Number(out.overflow.nextId.slice(1)) > 8);
});

test("the order of the pills is kept", () => {
  const out = pagerChips(pills(16), "p0");
  const order = out.chips.map((c) => Number(c.id.slice(1)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("at the end of the list +N wraps to the first hidden pill", () => {
  const out = pagerChips(pills(16), "p15");
  assert.equal(out.overflow?.nextId, "p0");
});

test("the 6 pills Settings allows plus sessions fit without folding", () => {
  // 6 integrations + 2 sessions, long active name.
  const out = pagerChips([...pills(7), pill("cc_x", "a-very-long-project-folder-name")], "cc_x");
  assert.equal(out.overflow, null);
  assert.equal(labelWidth("a-very-long-project-folder-name"), LABEL_MAX_W + 8, "long names are capped");
});

test("no pills, no chips", () => {
  assert.deepEqual(pagerChips([], "x"), { chips: [], overflow: null });
});
