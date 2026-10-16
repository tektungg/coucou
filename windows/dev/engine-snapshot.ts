// Dev harness: a deterministic picture of Mochi in every state, act, emote and
// badge, for checking that a refactor of mochi/engine.ts changes no pixel.
// The clock is frozen and Math.random seeded before the engine loads, so two
// runs of the same code draw the same bytes. Not part of the app bundle.
// With a dev server, open /dev/engine-snapshot.html; `document.title` reads
// "ready" once every cell is drawn.

let seed = 0x9e3779b9;
/** mulberry32: a tiny seeded PRNG in place of Math.random. */
Math.random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const FROZEN_MS = 100_000;
Object.defineProperty(performance, "now", { value: () => FROZEN_MS, configurable: true });

const { BotEngine, hexToRGB } = await import("../src/mochi/engine");
type Engine = InstanceType<typeof BotEngine>;
type Setup = (e: Engine) => void;

const SIZE = 120;
const OVERHANG = 40;
/** Frames stepped before the picture: springs and fades settle, tweens stay frozen. */
const STEPS = 90;
const at = (ageS: number) => FROZEN_MS - ageS * 1000;

const states = ["idle", "working", "thinking", "searching", "approval", "question", "error", "finished", "ratelimit", "sleeping", "dizzy"] as const;
const emotes = ["love", "surprised", "proud", "wink", "yawn", "happy", "annoyed"] as const;

const CASES: [string, Setup][] = [
  ...states.map((s): [string, Setup] => [s, (e) => e.setState(s, true)]),
  ...emotes.map((m): [string, Setup] => [`emote ${m}`, (e) => e.setPermanentEmote(m)]),
  ["music playing", (e) => { e.bodyColor = hexToRGB("#1DB954"); e.act = { name: "music", variant: "playing", at: 0 }; }],
  ["music cue", (e) => { e.act = { name: "musicCue", variant: "change", at: at(0.6) }; }],
  ["mic", (e) => { e.bodyColor = hexToRGB("#A78BFA"); e.act = { name: "mic", variant: null, at: 0 }; }],
  ["mic muted", (e) => { e.act = { name: "mic", variant: "muted", at: 0 }; }],
  ["mail", (e) => { e.bodyColor = hexToRGB("#5865F2"); e.act = { name: "mail", variant: null, at: at(1.2) }; }],
  ["catch", (e) => { e.act = { name: "catch", variant: null, at: at(1.0) }; }],
  ["check", (e) => { e.act = { name: "check", variant: null, at: at(1.2) }; }],
  ["check all", (e) => { e.act = { name: "check", variant: "all", at: at(1.6) }; }],
  ["claude edit", (e) => { e.setState("working", true); e.act = { name: "claude", variant: "working:edit", at: 0 }; }],
  ["claude bash", (e) => { e.setState("working", true); e.act = { name: "claude", variant: "working:bash", at: 0 }; }],
  ["claude read", (e) => { e.setState("working", true); e.act = { name: "claude", variant: "working:read", at: 0 }; }],
  ["claude think", (e) => { e.setState("thinking", true); e.act = { name: "claude", variant: "thinking", at: 0 }; }],
  ["claude ask", (e) => { e.setState("approval", true); e.act = { name: "claude", variant: "approval", at: 0 }; }],
  ["claude done", (e) => { e.act = { name: "claudeEnd", variant: "finished", at: at(0.8) }; }],
  ["claude error", (e) => { e.act = { name: "claudeEnd", variant: "error", at: at(0.8) }; }],
  ["badge dots", (e) => e.setBadge({ kind: "dots", color: hexToRGB("#F5A524") })],
  ["badge bang", (e) => e.setBadge({ kind: "bang", color: hexToRGB("#F4505E") })],
  ["badge question", (e) => e.setBadge({ kind: "question", color: hexToRGB("#22D3EE") })],
  ["box", (e) => { e.morph = 1; }],
  ["mini", (e) => { e.isMini = true; e.bodyColor = hexToRGB("#F4505E"); }],
  ["mini badge", (e) => { e.isMini = true; e.setBadge({ kind: "bang", color: hexToRGB("#F4505E") }); }],
  ["mini dots", (e) => { e.isMini = true; e.setState("working", true); e.setBadge({ kind: "dots", color: hexToRGB("#F5A524") }); }],
  ["look left", (e) => { e.lookX = -0.9; e.lookY = 0.4; }],
  ["particles love", (e) => e.emit("heart", 6)],
];

const stage = document.getElementById("stage")!;
const dpr = 1;
for (const [label, setup] of CASES) {
  const cell = document.createElement("div");
  cell.className = "cell";
  const canvas = document.createElement("canvas");
  canvas.width = SIZE * dpr;
  canvas.height = (SIZE + OVERHANG) * dpr;
  const name = document.createElement("span");
  name.textContent = label;
  cell.append(canvas, name);
  stage.append(cell);
  const engine = new BotEngine();
  engine.particleOverhang = OVERHANG;
  setup(engine);
  for (let i = 0; i < STEPS; i++) engine.update(1 / 60);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  engine.draw(ctx, SIZE, SIZE + OVERHANG);
}
document.title = "ready";
