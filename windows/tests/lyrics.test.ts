// Music card timing and lyric lines. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeLine,
  currentPositionMs,
  defaultQuery,
  durationMatch,
  hitKind,
  formatTime,
  LYRIC_LEAD_MS,
  lyricWindow,
  plainLines,
  progress,
  stripIslandWidth,
  stripText,
  subtitle,
  timelineOf,
  trackKey,
  type LyricLine,
} from "../src/views/lyrics.ts";

const lines: LyricLine[] = [
  { t: 1_500, text: "Baby" },
  { t: 3_200, text: "I'm just trying to play it cool" },
  { t: 6_000, text: "" },
  { t: 9_000, text: "Wait a minute" },
];

test("the position moves forward while playing", () => {
  const t = { playing: true, durationMs: 161_000, positionMs: 10_000, positionAtMs: 1_000_000 };
  assert.equal(currentPositionMs(t, 1_000_000), 10_000);
  assert.equal(currentPositionMs(t, 1_002_500), 12_500);
  // A clock that went backwards does not rewind the song.
  assert.equal(currentPositionMs(t, 999_000), 10_000);
});

test("the position stops at the end of the song", () => {
  const t = { playing: true, durationMs: 161_000, positionMs: 160_000, positionAtMs: 1_000_000 };
  assert.equal(currentPositionMs(t, 1_060_000), 161_000);
  assert.equal(progress(t, 1_060_000), 1);
});

test("a paused song stays put", () => {
  const t = { playing: false, durationMs: 161_000, positionMs: 42_000, positionAtMs: 1_000_000 };
  assert.equal(currentPositionMs(t, 9_000_000), 42_000);
});

test("an unknown length neither clamps nor shows progress", () => {
  const t = { playing: true, durationMs: 0, positionMs: 5_000, positionAtMs: 1_000 };
  assert.equal(currentPositionMs(t, 3_000), 7_000);
  assert.equal(progress(t, 3_000), 0);
});

test("timelineOf reads the poll's data defensively", () => {
  assert.deepEqual(timelineOf({}), { playing: false, durationMs: 0, positionMs: 0, positionAtMs: 0 });
  assert.deepEqual(
    timelineOf({ playing: true, durationMs: 161000, positionMs: -5, positionAtMs: 7, other: 1 }),
    { playing: true, durationMs: 161000, positionMs: 0, positionAtMs: 7 },
  );
  assert.equal(timelineOf({ playing: "true", durationMs: "161" }).playing, false);
});

test("activeLine finds the line being sung", () => {
  assert.equal(activeLine(lines, 0), -1);
  assert.equal(activeLine(lines, 1_499), -1);
  assert.equal(activeLine(lines, 1_500), 0);
  assert.equal(activeLine(lines, 3_199), 0);
  assert.equal(activeLine(lines, 3_200), 1);
  assert.equal(activeLine(lines, 7_000), 2);
  assert.equal(activeLine(lines, 1e9), 3);
  assert.equal(activeLine([], 5_000), -1);
});

test("activeLine with repeated stamps takes the last one written", () => {
  const same = [{ t: 1_000, text: "a" }, { t: 1_000, text: "b" }, { t: 2_000, text: "c" }];
  assert.equal(activeLine(same, 1_000), 1);
});

test("the lyric window shows the line before, the sung one and the next, a little early", () => {
  assert.deepEqual(lyricWindow(lines, 0), { index: -1, prev: "", current: "", next: "Baby" });
  assert.deepEqual(lyricWindow(lines, 1_500 - LYRIC_LEAD_MS), {
    index: 0, prev: "", current: "Baby", next: "I'm just trying to play it cool",
  });
  assert.deepEqual(lyricWindow(lines, 3_500), {
    index: 1, prev: "Baby", current: "I'm just trying to play it cool", next: "",
  });
  assert.deepEqual(lyricWindow(lines, 99_000), { index: 3, prev: "", current: "Wait a minute", next: "" });
  assert.deepEqual(lyricWindow([], 1_000), { index: -1, prev: "", current: "", next: "" });
});

test("the collapsed strip sings the line, else names the song", () => {
  const d = { title: "Love Shot", artist: "EXO" };
  assert.equal(stripText(d, lines, 2_000), "Baby");
  // Intro, a gap and no lyrics at all fall back to the song.
  assert.equal(stripText(d, lines, 0), "Love Shot · EXO");
  assert.equal(stripText(d, lines, 7_000), "Love Shot · EXO");
  assert.equal(stripText(d, [], 7_000), "Love Shot · EXO");
  assert.equal(stripText({ title: "Love Shot" }, [], 0), "Love Shot");
  assert.equal(stripText({}, [], 0), "");
});

test("times print like a player", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(999), "0:00");
  assert.equal(formatTime(42_000), "0:42");
  assert.equal(formatTime(161_000), "2:41");
  assert.equal(formatTime(725_000), "12:05");
  assert.equal(formatTime(3_723_000), "1:02:03");
  assert.equal(formatTime(-5), "0:00");
  assert.equal(formatTime(NaN), "0:00");
});

test("trackKey ignores the position but not the song", () => {
  const a = { app: "Spotify", title: "Magnetic", artist: "ILLIT", album: "SUPER REAL ME", durationMs: 160_900, positionMs: 1 };
  assert.equal(trackKey(a), trackKey({ ...a, positionMs: 90_000, playing: false, durationMs: 161_100 }));
  assert.notEqual(trackKey(a), trackKey({ ...a, title: "Lucky Girl Syndrome" }));
  assert.notEqual(trackKey(a), trackKey({ ...a, app: "Chrome" }));
});

test("subtitle joins what is there", () => {
  assert.equal(subtitle({ artist: "ILLIT", album: "SUPER REAL ME" }), "ILLIT · SUPER REAL ME");
  assert.equal(subtitle({ artist: "ILLIT", album: "" }), "ILLIT");
  assert.equal(subtitle({ album: "Album" }), "Album");
  assert.equal(subtitle({}), "");
});

test("plain lyrics squeeze blank runs and trim the edges", () => {
  assert.deepEqual(plainLines("\n\nBaby\r\n I want you \n\n\n\nWait\n\n"), ["Baby", "I want you", "", "Wait"]);
  assert.deepEqual(plainLines(null), []);
  assert.deepEqual(plainLines(""), []);
});

test("search rows say how well the length fits", () => {
  assert.equal(durationMatch(161_000, 161_000), "same");
  assert.equal(durationMatch(163_000, 161_000), "same");
  assert.equal(durationMatch(158_500, 161_000), "near");
  assert.equal(durationMatch(165_000, 161_000), "off");
  assert.equal(durationMatch(null, 161_000), "unknown");
  assert.equal(durationMatch(161_000, 0), "unknown");
});

test("the manual search starts from the title and the first artist", () => {
  assert.equal(defaultQuery({ title: "Love Shot", artist: "EXO" }), "Love Shot EXO");
  assert.equal(defaultQuery({ title: "Stay", artist: "The Kid LAROI, Justin Bieber" }), "Stay The Kid LAROI");
  assert.equal(defaultQuery({ title: "Song", artist: "A feat. B" }), "Song A");
  assert.equal(defaultQuery({ title: "Song", artist: "Simon & Garfunkel" }), "Song Simon");
  assert.equal(defaultQuery({ title: "Song" }), "Song");
  assert.equal(defaultQuery({}), "");
});

test("search rows name what kind of lyrics they hold", () => {
  const hit = { id: 1, title: "t", artist: "a", album: "", durationMs: 1, synced: true, plain: true, instrumental: false };
  assert.equal(hitKind(hit), "synced");
  assert.equal(hitKind({ ...hit, synced: false }), "plain");
  assert.equal(hitKind({ ...hit, synced: false, plain: false, instrumental: true }), "instrumental");
  assert.equal(hitKind({ ...hit, synced: false, plain: false }), "");
});

test("the collapsed island grows to fit a long line, within bounds", () => {
  // Short lines keep the minimum.
  assert.equal(stripIslandWidth(40, 420, 700), 420);
  assert.equal(stripIslandWidth(0, 420, 700), 420);
  assert.equal(stripIslandWidth(NaN, 420, 700), 420);
  // A long line: its width, both sides of room and some slack, on an 8 px step.
  assert.equal(stripIslandWidth(330, 420, 700), 464);
  assert.equal(stripIslandWidth(333, 420, 700) % 8, 0);
  assert.ok(stripIslandWidth(333, 420, 700) >= 333 + 2 * 58);
  // Longer than the window: capped, the line ellipsizes.
  assert.equal(stripIslandWidth(2_000, 420, 700), 700);
});
