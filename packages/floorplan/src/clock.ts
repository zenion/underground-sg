// A millisecond clock that works in Node, browsers and React Native without their type
// definitions: performance.now() where the global exists, else Date.now().

export function defaultClock(): () => number {
  const performance = (globalThis as { performance?: { now?: () => number } }).performance;
  const now = performance?.now;
  if (typeof now === "function") return () => now.call(performance);
  return () => Date.now();
}
