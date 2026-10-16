// Screenshots dev preview pages in headless Edge, in real time, so animations
// (the island opening, Mochi settling) finish before the shot. Edge's own
// --screenshot uses virtual time, which runs too few animation frames.
// No dependencies: Edge's DevTools protocol over a pipe (see cdp-pipe.mjs), so
// Edge cannot outlive this script. It once ran on a debugging port, and every
// run cut short (a timeout, Ctrl+C) left an Edge behind whose page windows
// piled up in Alt+Tab as "Coucou — Mochi Pop preview".
//
//   node scripts/shoot.mjs <out-dir> <url> [<url> ...]
//     --wait=<ms>        real time to wait after load (default 1500)
//     --size=<w>x<h>     viewport (default 900x340)
//     --clip=<x>,<y>,<w>,<h>  part of the page to keep (default: whole viewport)
//     --console          print the page's uncaught exceptions and console errors
//
// Each URL is saved as <out-dir>/<n>-<query>.png and the paths are printed.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectPipe } from "./cdp-pipe.mjs";

const EDGE = process.env.EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
/** How long Edge gets to close itself before its process tree is killed. */
const CLOSE_MS = 3000;
/** Edge's child processes can hold the profile a moment after it exits: retry this often, this many times. */
const RM_RETRY_MS = 200;
const RM_RETRIES = 10;
/** A profile left this long belongs to a run that was killed before it could tidy up. */
const STALE_PROFILE_MS = 60 * 60 * 1000;
const PROFILE_PREFIX = "coucou-shoot-";

function parseArgs(argv) {
  const opts = { wait: 1500, w: 900, h: 340, clip: null, console: false };
  const rest = [];
  for (const a of argv) {
    const [k, v] = a.split("=");
    if (k === "--wait") opts.wait = Number(v);
    else if (k === "--size") [opts.w, opts.h] = v.split("x").map(Number);
    else if (k === "--console") opts.console = true;
    else if (k === "--clip") {
      const [x, y, width, height] = v.split(",").map(Number);
      opts.clip = { x, y, width, height, scale: 1 };
    } else rest.push(a);
  }
  return { opts, out: rest[0], urls: rest.slice(1) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(cdp, url, file, opts) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  try {
    await s("Emulation.setDeviceMetricsOverride", { width: opts.w, height: opts.h, deviceScaleFactor: 1, mobile: false });
    await s("Page.enable");
    if (opts.console) await s("Runtime.enable");
    await s("Page.navigate", { url });
    await sleep(opts.wait);
    const shot = await s("Page.captureScreenshot", { format: "png", ...(opts.clip ? { clip: opts.clip } : {}) });
    writeFileSync(file, Buffer.from(shot.data, "base64"));
  } finally {
    await cdp.send("Target.closeTarget", { targetId });
  }
}

/** Uncaught exceptions and console.error from the page, one line each. */
function printPageError(msg) {
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.error(`page exception: ${d.exception?.description ?? d.text} (${d.url ?? ""}:${d.lineNumber})`);
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    console.error(`page console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  }
}

/** Starts headless Edge with the DevTools pipe on its fds 3 (in) and 4 (out). */
async function launchEdge(profile) {
  const edge = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--remote-debugging-pipe", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    edge.once("spawn", resolve);
    edge.once("error", (err) => reject(new Error(`Cannot start Edge (${EDGE}): ${err.message}`)));
  });
  return edge;
}

/** Shuts Edge down, every process of it, so no window outlives the run. */
async function closeEdge(edge, cdp) {
  if (edge.exitCode !== null || edge.signalCode !== null) return;
  const exited = new Promise((r) => edge.once("exit", r));
  cdp.send("Browser.close").catch(() => {}); // the reply may never come: Edge is gone by then
  const closed = await Promise.race([exited.then(() => true), sleep(CLOSE_MS).then(() => false)]);
  if (closed) return;
  // Still up: kill the whole tree, child processes included. A plain kill on
  // Windows ends only the browser process.
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
  else edge.kill("SIGKILL");
  await exited;
}

/** Deletes the profiles of earlier runs that were killed before their own cleanup. */
function sweepStaleProfiles() {
  const now = Date.now();
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
      if (now - statSync(dir).mtimeMs > STALE_PROFILE_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // still held by a live Edge, or gone already: the next run tries again
    }
  }
}

async function main() {
  const { opts, out, urls } = parseArgs(process.argv.slice(2));
  if (!out || urls.length === 0) {
    console.error("usage: node scripts/shoot.mjs <out-dir> <url>... [--wait=ms] [--size=WxH] [--clip=x,y,w,h]");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  sweepStaleProfiles();
  const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  try {
    const edge = await launchEdge(profile);
    const cdp = connectPipe(edge, opts.console ? printPageError : undefined);
    try {
      for (const [i, url] of urls.entries()) {
        const tag = (new URL(url).search.slice(1) || "page").replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
        const file = join(out, `${String(i + 1).padStart(2, "0")}-${tag}.png`);
        await shoot(cdp, url, file, opts);
        console.log(file);
      }
    } finally {
      await closeEdge(edge, cdp);
    }
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_MS });
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
