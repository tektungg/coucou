// A stand-in for the object Tauri injects into the webview. The island talks to
// Rust through it, so the tests see every command the island sends and can fire
// the events Rust would emit, through the real bridge, with no source changes.
// Ported from upstream (Louis-CFM/coucou 78815b5).

/** Every command the island invoked, oldest first: [name, args]. */
export const calls = [];

const listeners = new Map();

/** What a command answers, by name; unset commands answer null. */
const replies = new Map();

export const internals = {
  transformCallback: (callback) => callback,
  invoke: async (cmd, args) => {
    if (cmd === "plugin:event|listen") {
      listeners.set(args.event, args.handler);
      return listeners.size;
    }
    calls.push([cmd, args]);
    const reply = replies.get(cmd);
    return typeof reply === "function" ? reply(args) : reply ?? null;
  },
};

/** Fires an event the way the Rust side would. */
export function emit(event, payload) {
  const handler = listeners.get(event);
  if (!handler) throw new Error(`nothing listens to "${event}"`);
  handler({ event, id: 0, payload });
}

/** The commands invoked under one name, as a list of their arguments. */
export function sent(cmd) {
  return calls.filter(([name]) => name === cmd).map(([, args]) => args);
}

/** Makes `cmd` answer `reply` (a value, or a function of the args). */
export function answer(cmd, reply) {
  replies.set(cmd, reply);
}

/** Forgets the commands seen and the replies set, between tests. */
export function resetCalls() {
  calls.length = 0;
  replies.clear();
}
