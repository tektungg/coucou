// Shelf and Audio card logic. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageLabel, audioCardKey, defaultTab, isDrag, kindColor, micBadge, micUsersLabel, shelfCounts, shelfItems,
  sizeLabel, splitDeviceName, volumePct,
} from "../src/views/shelf.ts";

const item = (path: string, modified: number) => ({ path, name: path, size: 1, modified, kind: "image" });

test("the shelf opens on what was kept, else the newest folder", () => {
  assert.equal(defaultTab({ pinned: [item("a", 1)], screenshots: [item("s", 9)] }), "pinned");
  assert.equal(defaultTab({ screenshots: [item("s", 9)], downloads: [item("d", 5)] }), "screenshots");
  assert.equal(defaultTab({ screenshots: [item("s", 5)], downloads: [item("d", 9)] }), "downloads");
  assert.equal(defaultTab({}), "pinned");
});

test("shelf items and counts read the poll defensively", () => {
  const data = { pinned: [item("a", 1), null, { name: "no path" }], screenshots: "nope" };
  assert.deepEqual(shelfItems(data, "pinned").map((i) => i.path), ["a"]);
  assert.deepEqual(shelfCounts(data), { pinned: 1, screenshots: 0, downloads: 0 });
});

test("ages and sizes read short", () => {
  const now = 10_000_000;
  assert.equal(ageLabel(now - 5_000, now), "now");
  assert.equal(ageLabel(now - 5 * 60_000, now), "5m");
  assert.equal(ageLabel(now - 2 * 3_600_000, now), "2h");
  assert.equal(ageLabel(now - 3 * 86_400_000, now), "3d");
  assert.equal(ageLabel(now + 60_000, now), "now");
  assert.equal(sizeLabel(820), "820 B");
  assert.equal(sizeLabel(14 * 1024), "14 KB");
  assert.equal(sizeLabel(3.2 * 1024 * 1024), "3.2 MB");
  assert.equal(sizeLabel(-1), "");
});

test("a press becomes a drag after a few pixels", () => {
  assert.equal(isDrag(2, 2), false);
  assert.equal(isDrag(4, 3), true);
  assert.equal(isDrag(-6, 0), true);
});

test("unknown kinds get the neutral colour", () => {
  assert.equal(kindColor("image"), "#22C55E");
  assert.equal(kindColor("weird"), kindColor("other"));
});

test("the mic badge shows only while an app records", () => {
  assert.equal(micBadge(null), null);
  assert.equal(micBadge({ micUsers: [], input: { volume: 1, muted: false } }), null);
  assert.equal(micBadge({ micUsers: ["Discord"], input: { volume: 1, muted: false } }), "live");
  assert.equal(micBadge({ micUsers: ["Discord"], input: { volume: 1, muted: true } }), "muted");
  // No input device level known: an app records, so it is live.
  assert.equal(micBadge({ micUsers: ["Discord"] }), "live");
});

test("who uses the mic reads as a sentence", () => {
  assert.equal(micUsersLabel([]), "");
  assert.equal(micUsersLabel(["Discord"]), "Discord");
  assert.equal(micUsersLabel(["Discord", "Zoom"]), "Discord and Zoom");
  assert.equal(micUsersLabel(["Discord", "Zoom", "Zen"]), "Discord and 2 more");
});

test("device names split into name and driver", () => {
  assert.deepEqual(splitDeviceName("Speakers (Realtek(R) Audio)"), ["Speakers", "Realtek(R) Audio"]);
  assert.deepEqual(splitDeviceName("Microphone (NVIDIA Broadcast)"), ["Microphone", "NVIDIA Broadcast"]);
  assert.deepEqual(splitDeviceName("Headphones"), ["Headphones", ""]);
});

test("volumes print as whole percents", () => {
  assert.equal(volumePct(0.62), "62");
  assert.equal(volumePct(1.4), "100");
  assert.equal(volumePct(NaN), "0");
});

test("the audio card rebuilds for devices and mute, not for volume", () => {
  const base = {
    outputs: [{ id: "a", name: "Speakers", isDefault: true }],
    inputs: [{ id: "m", name: "Mic", isDefault: true }],
    output: { volume: 0.2, muted: false },
    input: { volume: 1, muted: false },
    micUsers: [],
  };
  assert.equal(audioCardKey(base), audioCardKey({ ...base, output: { volume: 0.8, muted: false } }));
  assert.notEqual(audioCardKey(base), audioCardKey({ ...base, output: { volume: 0.2, muted: true } }));
  assert.notEqual(audioCardKey(base), audioCardKey({ ...base, micUsers: ["Discord"] }));
  assert.notEqual(
    audioCardKey(base),
    audioCardKey({ ...base, outputs: [{ id: "a", name: "Speakers", isDefault: false }, { id: "b", name: "HDMI", isDefault: true }] }),
  );
});
