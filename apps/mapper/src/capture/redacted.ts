// Pose-bearing values from the capture module (ADR 0005, ADR 0010 "Privacy"): poses, transforms,
// raycast hits, positions and session times reach TypeScript inside a Redacted wrapper. Printing
// one in any way gives "[redacted]": String(), a template literal, JSON.stringify, Node's
// util.inspect and React Native's console all see only that. Only unwrap() reads the value, and
// only the code that uses it (and the boundary trace, which sees the raw result first) may call it.
//
// The value lives in a module-level WeakMap, not on the object, so nothing that walks an object's
// own properties (React Native's console formatting, a crash reporter's serializer) can find it.
// Environment-neutral: Node's inspect hook is looked up by its registered symbol, not imported.

const REDACTED = "[redacted]";
const INSPECT: unique symbol = Symbol.for("nodejs.util.inspect.custom");
const values = new WeakMap<Redacted<unknown>, unknown>();

export class Redacted<T> {
  constructor(value: T) {
    values.set(this, value);
    Object.freeze(this);
  }

  /** The value itself. Call it only where the value is used, never to print or log it. */
  unwrap(): T {
    return values.get(this) as T;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return REDACTED;
  }
}

/** Seconds since the ARKit session started (the module's session clock), always wrapped. */
export type SessionTime = Redacted<number>;

export function redact<T>(value: T): Redacted<T> {
  return new Redacted(value);
}

export function isRedacted(value: unknown): value is Redacted<unknown> {
  return value instanceof Redacted;
}
