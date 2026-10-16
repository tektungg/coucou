// Dev harness: the launch greeting (mochi/greeting.ts) frozen at a series of
// moments, with and without the collapse, for checking that a refactor changes
// no pixel. Not part of the app bundle. `document.title` reads "ready" once
// every frame is drawn.

let fakeNow = 0;
Object.defineProperty(performance, "now", { value: () => fakeNow, configurable: true });
const { Greeting, GREETING_H, GREETING_W } = await import("../src/mochi/greeting");

/** Seconds into the greeting, then the moment a collapse began (null: none). */
const FRAMES: [number, number | null][] = [
  [0.1, null], [0.3, null], [0.5, null], [0.7, null], [0.9, null], [1.25, null], [1.4, null], [1.7, null],
  [2.2, null], [2.5, null], [2.75, null], [3.1, null], [3.75, null], [4.0, null], [4.5, null],
  [1.1, 1.0], [1.2, 1.0], [1.4, 1.0], [2.6, 2.5], [2.8, 2.5],
];

const stage = document.getElementById("stage")!;
for (const [t, collapseAt] of FRAMES) {
  const canvas = document.createElement("canvas");
  canvas.width = GREETING_W;
  canvas.height = GREETING_H;
  stage.append(canvas);
  const g = new Greeting();
  fakeNow = 0;
  g.start();
  if (collapseAt != null) {
    fakeNow = collapseAt * 1000;
    g.interrupt();
  }
  fakeNow = t * 1000;
  g.draw(canvas.getContext("2d")!);
}
document.title = "ready";
