// What the page says when it has no map version to draw: nothing published yet, the server
// unreachable, or files it can't read. Also when it can't draw a map at all (no WebGL 2), and when
// the page itself fails.

import type { DataState } from "./load.ts";

export interface StateMessageText {
  readonly title: string;
  readonly text: string;
  /** The technical reason, for whoever runs the server. */
  readonly detail?: string;
  /**
   * "retry" loads the files again; "reload" reloads the page, for a newer format or after a
   * failure that loading the files again can't fix.
   */
  readonly action: "retry" | "reload";
  /** "info" when nothing is wrong (nothing published yet), "error" otherwise. */
  readonly tone: "info" | "error";
}

function errorDetail(error: unknown): string | undefined {
  if (error instanceof Error) return error.message === "" ? error.name : error.message;
  return error === undefined ? undefined : String(error);
}

/**
 * The message when the map can't be created: MapLibre GL JS 6 needs WebGL 2 and throws without it
 * (WebGL turned off, a blocklisted GPU, or no memory for a context).
 */
export function rendererMessage(error: unknown): StateMessageText {
  const detail = errorDetail(error);
  return {
    title: "This browser can't draw the map",
    text: "The map needs WebGL 2, which is turned off or not supported in this browser. Turn on hardware (graphics) acceleration in its settings, or try another browser, then reload.",
    ...(detail === undefined ? {} : { detail }),
    action: "reload",
    tone: "error",
  };
}

/** The message when the page itself failed (the error boundary's), so it never goes blank. */
export function crashMessage(error: unknown): StateMessageText {
  const detail = errorDetail(error);
  return {
    title: "Something went wrong",
    text: "The page stopped working. Reloading it usually helps.",
    ...(detail === undefined ? {} : { detail }),
    action: "reload",
    tone: "error",
  };
}

/** The message for a state, or undefined when the state needs none (loading, or the map ready). */
export function stateMessage(state: DataState): StateMessageText | undefined {
  switch (state.kind) {
    case "no-version":
      return {
        title: "No map published yet",
        text: "The map server is up, but no version of the underground map has been published. The street map still works.",
        action: "retry",
        tone: "info",
      };
    case "unreachable":
      return {
        title: "Can't reach the map server",
        text: "The underground map couldn't be loaded. Check your connection and try again.",
        detail: state.detail,
        action: "retry",
        tone: "error",
      };
    case "invalid":
      return state.outdated
        ? {
            title: "This page is out of date",
            text: "The published map is in a newer format than this page reads. Reload to update.",
            detail: state.detail,
            action: "reload",
            tone: "error",
          }
        : {
            title: "The map data couldn't be read",
            text: "The published files aren't in the expected format.",
            detail: state.detail,
            action: "retry",
            tone: "error",
          };
    case "loading":
    case "ready":
      return undefined;
  }
}
