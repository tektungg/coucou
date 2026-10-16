// The DevTools pipe client behind scripts/shoot.mjs (scripts/cdp-pipe.mjs). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { connectPipe, encodeFrame, frameReader } from "../scripts/cdp-pipe.mjs";

const collect = () => {
  const got: object[] = [];
  return { got, feed: frameReader((m: object) => got.push(m)) };
};

test("a frame is the JSON text ended by one NUL", () => {
  assert.equal(encodeFrame({ id: 1, method: "Browser.close" }), '{"id":1,"method":"Browser.close"}\0');
});

test("several frames in one chunk come out in order", () => {
  const { got, feed } = collect();
  feed(encodeFrame({ id: 1 }) + encodeFrame({ id: 2 }));
  assert.deepEqual(got, [{ id: 1 }, { id: 2 }]);
});

test("a frame split across chunks waits for its end", () => {
  const { got, feed } = collect();
  const frame = encodeFrame({ id: 7, result: { title: "Coucou — Mochi Pop preview" } });
  feed(frame.slice(0, 10));
  assert.deepEqual(got, []);
  feed(frame.slice(10));
  assert.deepEqual(got, [{ id: 7, result: { title: "Coucou — Mochi Pop preview" } }]);
});

test("a chunk ending exactly on a NUL leaves nothing pending", () => {
  const { got, feed } = collect();
  feed(encodeFrame({ id: 1 }));
  feed(encodeFrame({ id: 2 }));
  assert.deepEqual(got, [{ id: 1 }, { id: 2 }]);
});

/** A stand-in for the spawned browser: fd 3 is what we write, fd 4 what it answers. */
function fakeBrowser() {
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, new PassThrough({ encoding: "utf8" }), new PassThrough()],
  });
  const written = () => (child.stdio[3].read() ?? "") as string;
  const reply = (msg: object) => child.stdio[4].write(encodeFrame(msg));
  return { child, written, reply };
}

test("send writes a framed command and resolves with its reply", async () => {
  const { child, written, reply } = fakeBrowser();
  const cdp = connectPipe(child);
  const pending = cdp.send("Target.createTarget", { url: "about:blank" });
  assert.equal(written(), encodeFrame({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } }));
  reply({ id: 1, result: { targetId: "T1" } });
  assert.deepEqual(await pending, { targetId: "T1" });
});

test("an error reply rejects with the browser's message", async () => {
  const { child, reply } = fakeBrowser();
  const pending = connectPipe(child).send("Page.navigate", { url: "x" });
  reply({ id: 1, error: { message: "Cannot navigate to invalid URL" } });
  await assert.rejects(pending, /Cannot navigate to invalid URL/);
});

test("events go to onEvent, not to a pending command", async () => {
  const { child, reply } = fakeBrowser();
  const events: object[] = [];
  const cdp = connectPipe(child, (m: object) => events.push(m));
  const pending = cdp.send("Page.enable");
  reply({ method: "Runtime.exceptionThrown", params: {} });
  reply({ id: 1, result: {} });
  assert.deepEqual(await pending, {});
  assert.deepEqual(events, [{ method: "Runtime.exceptionThrown", params: {} }]);
});

test("a browser that exits rejects every command still waiting", async () => {
  const { child } = fakeBrowser();
  const pending = connectPipe(child).send("Page.captureScreenshot");
  child.emit("exit", 1);
  await assert.rejects(pending, /the browser exited/);
});
