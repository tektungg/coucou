// A tiny DevTools protocol client over Chromium's --remote-debugging-pipe.
// The browser reads commands on its fd 3 and writes replies and events on fd 4,
// each message a JSON text ended by a NUL byte. Unlike a debugging port, the
// pipe ties the browser's life to ours: when this process dies, even killed
// mid-run, the pipe closes and the browser shuts down with every window it had.

/** One message as the pipe carries it. */
export const encodeFrame = (msg) => `${JSON.stringify(msg)}\0`;

/**
 * Feeds pipe text in, hands whole messages out. A message can arrive split
 * across chunks, so the unfinished tail waits for the next one.
 */
export function frameReader(onMessage) {
  let tail = "";
  return (chunk) => {
    const parts = (tail + chunk).split("\0");
    tail = parts.pop();
    for (const part of parts) if (part) onMessage(JSON.parse(part));
  };
}

/**
 * Talks to a browser spawned with stdio[3] and stdio[4] as pipes.
 * send(method, params, sessionId) resolves with the result; events go to `onEvent`.
 */
export function connectPipe(child, onEvent) {
  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  let id = 0;
  const pending = new Map();
  fromBrowser.setEncoding("utf8"); // keeps a UTF-8 character split across chunks whole
  fromBrowser.on("data", frameReader((msg) => {
    if (msg.method) return onEvent?.(msg);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }));
  // A browser that dies mid-command would otherwise leave the caller waiting forever.
  child.once("exit", () => {
    for (const p of pending.values()) p.reject(new Error("the browser exited"));
    pending.clear();
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      toBrowser.write(encodeFrame({ id, method, params, sessionId }));
    });
  return { send };
}
