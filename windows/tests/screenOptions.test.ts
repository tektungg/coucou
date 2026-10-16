// Settings → General → Island lives on. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { screenOptions } from "../src/settings/general.ts";

const left = { key: "at:-2560,0", label: "DELL U2720Q · 2560×1440 at -2560,0" };
const main = { key: "at:0,0", label: "Built-in · 1920×1080 at 0,0" };

test("the fixed choices come first, then each display", () => {
  const { options } = screenOptions([left, main], "primary");
  assert.deepEqual(options.map(([key]) => key), ["primary", "cursor", "at:-2560,0", "at:0,0"]);
  assert.equal(options[2][1], left.label);
});

test("a chosen display stays selected while it is connected", () => {
  assert.equal(screenOptions([left, main], "at:-2560,0").value, "at:-2560,0");
  assert.equal(screenOptions([left, main], "cursor").value, "cursor");
});

test("a display that is gone shows as the main one", () => {
  assert.equal(screenOptions([main], "at:-2560,0").value, "primary");
  assert.equal(screenOptions([], "at:0,0").value, "primary");
});
