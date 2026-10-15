// Which JavaScript engine is running: Hermes sets a HermesInternal global.

export interface JsEngine {
  readonly name: "Hermes" | "not Hermes";
  /** Hermes's release version, when it reports one. */
  readonly version: string | null;
}

interface HermesInternal {
  getRuntimeProperties?: () => Record<string, unknown>;
}

export function jsEngine(global: object = globalThis): JsEngine {
  const hermes = (global as { HermesInternal?: HermesInternal | null }).HermesInternal;
  if (typeof hermes !== "object" || hermes === null) return { name: "not Hermes", version: null };
  let version: string | null = null;
  try {
    const value = hermes.getRuntimeProperties?.()["OSS Release Version"];
    if (typeof value === "string" && value.length > 0) version = value;
  } catch {
    // Older Hermes builds have no runtime properties.
  }
  return { name: "Hermes", version };
}
