// Order of the Space card's task list. No DOM here, tested alone.

/** Open tasks first, done ones after; Space's own order is kept inside each group. */
export function sortSpaceItems<T extends { done?: unknown }>(items: readonly T[]): T[] {
  return [...items.filter((it) => it.done !== true), ...items.filter((it) => it.done === true)];
}
