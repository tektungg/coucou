// Screenshots dev preview pages in headless Edge, in real time, so animations
// (the island opening, Mochi settling) finish before the shot. Edge's own
// --screenshot uses virtual time, which runs too few animation frames.
// No dependencies: Edge's DevTools protocol over Node's global WebSocket.
//
//   node scripts/shoot.mjs <out-dir> <url> [<url> ...]
//     --wait=<ms>        real time to wait after load (default 1500)
//     --size=<w>x<h>     viewport (default 900x340)
//     --clip=<x>,<y>,<w>,<h>  part of the page to keep (default: whole viewport)
//
// Each URL is saved as <out-dir>/<n>-<query>.png and the paths are printed.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9333;
/** Edge needs a moment to open its DevTools port: poll this often, this many times. */
const POLL_MS = 200;
const POLL_TRIES = 50;

function parseArgs(argv) {
  const opts = { wait: 1500, w: 900, h: 340, clip: null };
  const rest = [];
  for (const a of argv) {
    const [k, v] = a.split("=");
    if (k === "--wait") opts.wait = Number(v);
    else if (k === "--size") [opts.w, opts.h] = v.split("x").map(Number);
    else if (k === "--clip") {
      const [x, y, width, height] = v.split(",").map(Number);
      opts.clip = { x, y, width, height, scale: 1 };
    } else rest.push(a);
  }
  return { opts, out: rest[0], urls: rest.slice(1) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The DevTools endpoint, once Edge is listening. */
async function devtools() {
  for (let i = 0; i < POLL_TRIES; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    } catch {
      await sleep(POLL_MS); // not listening yet
    }
  }
  throw new Error("Edge did not open its DevTools port");
}

/** A tiny CDP client: send(method, params) resolves with the result. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, close: () => ws.close() });
    ws.onerror = () => reject(new Error(`Cannot reach Edge DevTools at ${wsUrl}`));
  });
}

async function shoot(cdp, url, file, opts) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  await s("Emulation.setDeviceMetricsOverride", { width: opts.w, height: opts.h, deviceScaleFactor: 1, mobile: false });
  await s("Page.enable");
  await s("Page.navigate", { url });
  await sleep(opts.wait);
  const shot = await s("Page.captureScreenshot", { format: "png", ...(opts.clip ? { clip: opts.clip } : {}) });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  await cdp.send("Target.closeTarget", { targetId });
}

async function main() {
  const { opts, out, urls } = parseArgs(process.argv.slice(2));
  if (!out || urls.length === 0) {
    console.error("usage: node scripts/shoot.mjs <out-dir> <url>... [--wait=ms] [--size=WxH] [--clip=x,y,w,h]");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "coucou-shoot-"));
  const edge = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });
  try {
    const cdp = await connect((await devtools()).webSocketDebuggerUrl);
    for (const [i, url] of urls.entries()) {
      const tag = (new URL(url).search.slice(1) || "page").replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
      const file = join(out, `${String(i + 1).padStart(2, "0")}-${tag}.png`);
      await shoot(cdp, url, file, opts);
      console.log(file);
    }
    cdp.close();
  } finally {
    const exited = new Promise((r) => edge.once("exit", r));
    edge.kill();
    await exited;
    // Edge's child processes can hold the profile a moment longer.
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: POLL_MS });
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
