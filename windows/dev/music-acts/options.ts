// Dev page: every Music act option (mochi/musicProps.ts, acts.ts "music" and
// "musicCue") on the real Mochi through the real act pipeline, at a roomy size
// and at the island's own bot canvas size, so the ones that ship can be
// picked. Not part of the app bundle. With `npm run dev`, open
// http://127.0.0.1:1420/dev/music-acts-options.html

import { BotEngine, hexToRGB } from "../../src/mochi/engine";
import { actDurationMs, isOneShot, type Act, type ActName } from "../../src/mochi/acts";

interface Option { code: string; title: string; desc: string; rec?: boolean }
interface Section { id: string; title: string; when: string; act: ActName; options: Option[]; current?: Option }

const SECTIONS: Section[] = [
  {
    id: "1", title: "1 · Playing", act: "music", when: "Saat lagu diputar (pill Music working).",
    current: { code: "dance", title: "Sekarang", desc: "Joget yang sekarang dipakai, untuk perbandingan." },
    options: [
      { code: "1A", title: "Bop", rec: true, desc: "Joget yang sekarang, headphone HD: bantalan, ring pink yang menyala tiap ketukan, gelombang suara di samping." },
      { code: "1B", title: "DJ", desc: "Turntable di depan, satu tangan scratch piringan, satu di fader. Mengangguk keras tiap ketukan." },
      { code: "1C", title: "Boombox", desc: "Boombox retro dipegang rendah, speaker berdentum, bar EQ melompat, Mochi side-step." },
    ],
  },
  {
    id: "2", title: "2 · Singing", act: "music", when: "Lagu diputar dan lirik synced sedang tampil (ganti Playing selama ada lirik).",
    options: [
      { code: "2A", title: "Karaoke", rec: true, desc: "Mic genggam pink dengan kabel, mata senang, condong ke mic tiap ketukan." },
      { code: "2B", title: "Crooner", desc: "Mic kapsul chrome di stand, dua tangan di mic, mata terpejam, ayun pelan." },
      { code: "2C", title: "Diva", desc: "Sisir rambut jadi mic, kepala mendongak, tangan satu di udara, kilau bintang." },
    ],
  },
  {
    id: "3", title: "3 · Paused", act: "music", when: "Ada lagu tapi di-pause.",
    options: [
      { code: "3A", title: "Menunggu", rec: true, desc: "Headphone turun ke leher, gelembung ⏸ di atas, napas pelan." },
      { code: "3B", title: "Mixtape", desc: "Memegang kaset, melihatnya, kaki mengetuk pelan." },
      { code: "3C", title: "Ketiduran", desc: "Headphone masih terpasang miring, mata terpejam, huruf Z melayang." },
    ],
  },
  {
    id: "4", title: "4 · Ganti lagu", act: "musicCue", when: "Judul lagu berganti saat diputar (next, prev, lagu berikutnya).",
    options: [
      { code: "4A", title: "Tukar piringan", rec: true, desc: "Piringan lama tenggelam, yang baru jatuh berputar dan ditangkap, lalu lompat." },
      { code: "4B", title: "Balik kaset", desc: "Kaset diputar dari side A ke side B, panah berputar di samping." },
      { code: "4C", title: "Skip", desc: "Tangan menyapu dengan garis kecepatan, ikon ⏭ terbang ke kanan." },
    ],
  },
  {
    id: "5", title: "5 · Lanjut play", act: "musicCue", when: "Dari pause ke play.",
    options: [
      { code: "5A", title: "Jarum turun", desc: "Tonearm turun ke piringan, Mochi jongkok lalu melompat, riak suara." },
      { code: "5B", title: "Tombol play", desc: "Tombol play besar ditekan tangan, riak saat ditekan, lompat senang." },
      { code: "5C", title: "Pasang headphone", rec: true, desc: "Headphone turun dari atas ke telinga, klik, ring menyala, not musik naik." },
    ],
  },
];

const MUSIC_GREEN = "#1DB954";
const OVERHANG = 40; // island.ts BOT_OVERHANG
const BIG_W = 230;
/** island.ts: canvas = diameter / 0.6 wide; Home's Mochi is 58 px. */
const ISLAND_W = Math.round(58 / 0.6);
const REPLAY_GAP_MS = 900;
const STORE = "music-acts-picks";
const dpr = Math.max(2, window.devicePixelRatio || 1);

interface Bot { engine: BotEngine; canvas: HTMLCanvasElement; w: number; act: ActName; variant: string | null }

/** "1A" or "skip" per section id. */
let picks: Record<string, string> = load();

function load(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (saved && typeof saved === "object") return saved as Record<string, string>;
  } catch { /* storage off: start from the recommended ones */ }
  return Object.fromEntries(SECTIONS.map((s) => [s.id, s.options.find((o) => o.rec)?.code ?? s.options[0].code]));
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(picks));
  } catch { /* not kept, still shown */ }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function makeBot(act: ActName, variant: string | null, w: number): Bot {
  const canvas = el("canvas");
  canvas.width = w * dpr;
  canvas.height = (w + OVERHANG) * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${w + OVERHANG}px`;
  const engine = new BotEngine();
  engine.bodyColor = hexToRGB(MUSIC_GREEN);
  engine.particleOverhang = OVERHANG;
  return { engine, canvas, w, act, variant };
}

function card(section: Section, o: Option, bots: Bot[], ref = false): HTMLElement {
  const act: ActName = ref ? "dance" : section.act;
  const variant = ref ? null : o.code;
  const big = makeBot(act, variant, BIG_W);
  const small = makeBot(act, variant, ISLAND_W);
  bots.push(big, small);
  const island = el("div", "island");
  island.append(small.canvas, el("small", "", "di island"));
  const stage = el("div", "stage");
  stage.append(big.canvas, island);
  const meta = el("div", "meta");
  const line = el("div");
  line.append(el("span", "code", ref ? "SEKARANG" : o.code), el("b", "", o.title));
  if (o.rec) line.append(el("span", "tag", "Rekomendasi"));
  if (ref) line.append(el("span", "tag ref", "Pembanding"));
  meta.append(line, el("p", "", o.desc));
  const box = el("div", ref ? "opt ref" : "opt");
  box.dataset.code = o.code;
  if (!ref) box.append(el("span", "check", "✓"));
  box.append(stage, meta);
  if (!ref) box.addEventListener("click", () => pick(section.id, o.code));
  return box;
}

function build(): Bot[] {
  const root = document.getElementById("sections")!;
  const bots: Bot[] = [];
  for (const s of SECTIONS) {
    const sec = el("section");
    sec.dataset.id = s.id;
    const head = el("div", "head");
    head.append(el("h2", "", s.title), el("span", "kind", isOneShot(s.act) ? "One-shot" : "Continuous"), el("span", "when", s.when));
    const skip = el("button", "skip", "Lewati state ini");
    skip.addEventListener("click", () => pick(s.id, picks[s.id] === "skip" ? s.options.find((o) => o.rec)?.code ?? s.options[0].code : "skip"));
    head.append(skip);
    const opts = el("div", "opts");
    for (const o of s.options) opts.append(card(s, o, bots));
    if (s.current) opts.append(card(s, s.current, bots, true));
    sec.append(head, opts);
    root.append(sec);
  }
  return bots;
}

function pick(id: string, code: string) {
  picks = { ...picks, [id]: code };
  save();
  render();
}

function summary(): string {
  return SECTIONS.map((s) => `${s.title.split(" · ")[1]}: ${picks[s.id] === "skip" ? "lewati" : picks[s.id] ?? "-"}`).join(", ");
}

function render() {
  for (const sec of document.querySelectorAll<HTMLElement>("section")) {
    const choice = picks[sec.dataset.id ?? ""];
    for (const o of sec.querySelectorAll<HTMLElement>(".opt:not(.ref)")) o.classList.toggle("picked", o.dataset.code === choice);
    sec.querySelector(".skip")?.classList.toggle("on", choice === "skip");
  }
  const bar = document.getElementById("bar")!;
  bar.replaceChildren(el("span", "lbl", "Pilihan"));
  for (const s of SECTIONS) {
    const c = picks[s.id];
    bar.append(el("span", c === "skip" ? "chip skip" : c ? "chip" : "chip none", c === "skip" ? `${s.id}: lewati` : c ?? `${s.id}: -`));
  }
  const copy = el("button", "copy", "Salin pilihan");
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(`Animasi musik: ${summary()}`).then(() => {
      copy.textContent = "Tersalin ✓";
      copy.classList.add("done");
    });
  });
  bar.append(copy);
}

/** One-shots restart every (duration + gap); continuous acts follow the free clock. */
function actNow(b: Bot, base: number, now: number): Act {
  if (!isOneShot(b.act)) return { name: b.act, variant: b.variant, at: 0 };
  const cycle = actDurationMs(b.act, b.variant) + REPLAY_GAP_MS;
  return { name: b.act, variant: b.variant, at: base + Math.floor((now - base) / cycle) * cycle };
}

const bots = build();
render();
const base = performance.now();
for (const b of bots) b.engine.setActNow(actNow(b, base, base));
let last = base;
function loop(now: number) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  for (const b of bots) {
    b.engine.act = actNow(b, base, now);
    b.engine.update(dt);
    const x = b.canvas.getContext("2d")!;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, b.w, b.w + OVERHANG);
    b.engine.draw(x, b.w, b.w + OVERHANG);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
