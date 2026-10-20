// A fake capture module for the adapter's tests: a CaptureSession that emits what a test tells it
// to and records the calls made on it, the boundary lines included. Synthetic values only.

import type {
  Capabilities,
  CaptureNativeModule,
  CaptureSession,
  CaptureSessionEvents,
  NativeAddTagResult,
  NativeMarkAnchorResult,
  NativeStopResult,
} from "../modules/capture-native/src/types.ts";

export const SYNTHETIC_CAPABILITIES: Capabilities = {
  worldTracking: true,
  sceneReconstruction: true,
  sceneDepth: true,
  smoothedSceneDepth: true,
  videoFormats: [{ width: 1920, height: 1440, fps: 60 }],
  deviceModel: "iPhone18,2",
  osVersion: "26.7",
  thermal: "nominal",
  recorder: false,
};

export interface BoundaryBatch {
  readonly lines: string[];
  readonly final: boolean;
}

type EventName = keyof CaptureSessionEvents;

export class FakeSession {
  readonly calls: string[] = [];
  readonly batches: BoundaryBatch[] = [];
  released = false;
  markResult: NativeMarkAnchorResult | null = null;
  tagResult: NativeAddTagResult | null = null;
  stopResult: NativeStopResult = { t: 0, recording: null };
  appendFails = false;
  /** When set, start rejects with it. */
  startError: unknown = null;
  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  addListener<E extends EventName>(event: E, listener: CaptureSessionEvents[E]) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (event: never) => void);
    return { remove: () => set.delete(listener as (event: never) => void) };
  }

  listenerCount(event: EventName): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  emit<E extends EventName>(event: E, payload: Parameters<CaptureSessionEvents[E]>[0]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (event: typeof payload) => void)(payload);
    }
  }

  readonly startOptions: unknown[] = [];
  readonly markOptions: unknown[] = [];
  readonly tagOptions: unknown[] = [];

  async start(options?: unknown): Promise<{ recordingId: string | null }> {
    this.calls.push("start");
    this.startOptions.push(options);
    if (this.startError) throw this.startError;
    return { recordingId: null };
  }

  async markAnchor(options?: unknown): Promise<NativeMarkAnchorResult> {
    this.calls.push("markAnchor");
    this.markOptions.push(options);
    if (!this.markResult)
      throw Object.assign(new Error("ERR_NO_FLOOR_HIT"), { code: "ERR_NO_FLOOR_HIT" });
    return this.markResult;
  }

  async addTag(options?: unknown): Promise<NativeAddTagResult> {
    this.calls.push("addTag");
    this.tagOptions.push(options);
    if (!this.tagResult) throw Object.assign(new Error("ERR_TRACKING"), { code: "ERR_TRACKING" });
    return this.tagResult;
  }

  async stop(): Promise<NativeStopResult> {
    this.calls.push("stop");
    return this.stopResult;
  }

  async discard(): Promise<void> {
    this.calls.push("discard");
  }

  async appendBoundary(lines: string[], final: boolean): Promise<void> {
    this.calls.push(final ? "appendBoundary(final)" : "appendBoundary");
    this.batches.push({ lines, final });
    if (this.appendFails) throw new Error("ERR_IO");
  }

  release(): void {
    this.released = true;
  }
}

/** A module object with the CaptureSession class; `sessions` holds every session it made. */
export function fakeModule(options: { withSession: boolean; capabilities?: Capabilities }): {
  module: CaptureNativeModule;
  sessions: FakeSession[];
} {
  const sessions: FakeSession[] = [];
  const module: CaptureNativeModule = {
    getCapabilities: () => options.capabilities ?? SYNTHETIC_CAPABILITIES,
  };
  if (options.withSession) {
    module.CaptureSession = function MadeSession() {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    } as unknown as new () => CaptureSession;
  }
  return { module, sessions };
}
