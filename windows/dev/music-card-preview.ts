// Dev harness: the Music card (views/personal.ts) in a plain browser, with a
// fake song and fake lyrics, so its layout can be checked without Spotify.
// Not part of the app bundle. With `npm run dev`, open
// http://127.0.0.1:1420/dev/music-card-preview.html
// `?nolyrics` turns the Lyrics setting off; `?long` uses a long title and line.

const params = new URLSearchParams(location.search);
const long = params.has("long");

// Placeholder lines (not a real song), timed 4 s apart.
const LINES = [
  "Morning light across the empty street",
  "I keep the window open just in case",
  long
    ? "And every word I never said comes rushing back like rain against the glass tonight"
    : "And every word comes rushing back",
  "Hold on, the night is almost over",
  "We can start again tomorrow",
];

// Bridge only talks to Rust when Tauri is there: fake it before the app modules
// load, answering the two calls the card makes.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (cmd: string) => {
    if (cmd === "media_lyrics") {
      return {
        id: 1, plain: null, instrumental: false, chosen: false, lang: null, romanized: null, romanizedPlain: null,
        synced: LINES.map((text, i) => ({ t: i * 4000, text })),
      };
    }
    return null;
  },
};

const { State, INTEGRATION_AGENTS } = await import("../src/core/state");
await import("../src/style.css");
const { renderPersonalCard } = await import("../src/views/personal");

State.mode = "expanded";
State.settings.lyricsEnabled = !params.has("nolyrics");
State.integrations.integration_media = {
  loaded: true, configured: true, error: null,
  data: {
    app: "Spotify",
    title: long ? "A Very Long Song Title (Extended Anniversary Version)" : "Placeholder Song",
    artist: long ? "Somebody Featuring Somebody Else" : "Some Artist",
    album: "Preview",
    playing: true,
    durationMs: 215_000,
    positionMs: 8_500, // the third line is being sung
    positionAtMs: Date.now(),
    canPrev: true, canNext: true, canPlayPause: true,
  },
};

// State.tasks only holds the pills Settings turned on; take the definition itself.
const task = INTEGRATION_AGENTS.find((t) => t.id === "integration_media")!;
const frame = document.createElement("div");
frame.className = "frame";
frame.append(document.createElement("div"));
frame.firstElementChild!.className = "mochi";
const card = renderPersonalCard(task, false, () => {}, () => {});
if (card) frame.append(card);
document.getElementById("cards")!.append(frame);
