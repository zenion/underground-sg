// Loads the current map version the way docs/snapshot-format.md describes: latest.json, then the
// two version files it names, then status.json. The outcome is one DataState, which the page shows
// as the map or as a message: still loading, nothing published yet, the server unreachable, or
// files it can't read.

import {
  checkIndoorSnapshot,
  checkStreetConnectors,
  checkStreetSnapshot,
  type IndoorSnapshot,
  type LatestPointer,
  type StatusOverlay,
  type StreetSnapshot,
} from "@usg/contracts";
import {
  DataShapeError,
  parseIndoor,
  parseLatest,
  parseStatus,
  parseStreet,
  UnsupportedFormatError,
} from "./shapes.ts";
import { emptyStatus, statusForVersion } from "./status.ts";
import { latestUrl, statusUrl, type VersionFileUrls, versionFileUrls } from "./urls.ts";

/** A published version, loaded and checked. */
export interface LoadedMap {
  readonly latest: LatestPointer;
  readonly indoor: IndoorSnapshot;
  readonly street: StreetSnapshot;
  /** status.json narrowed to this version's nodes and edges; empty when there was none. */
  readonly status: StatusOverlay;
  readonly urls: VersionFileUrls;
  /**
   * Problems that don't stop the map from drawing: the checks across features that the schemas
   * leave to code (references, ordinals, sort order), and an unreadable status.json.
   */
  readonly warnings: readonly string[];
}

/** What the page shows. */
export type DataState =
  | { readonly kind: "loading" }
  /** No latest.json: the server answers, but nothing has been published. */
  | { readonly kind: "no-version" }
  /** The server can't be reached or failed (a network error, or an HTTP error other than 404). */
  | { readonly kind: "unreachable"; readonly detail: string }
  /**
   * A file that isn't what the format says. `outdated`: the files are in a newer format than this
   * build reads, so reloading the page should fix it.
   */
  | { readonly kind: "invalid"; readonly detail: string; readonly outdated: boolean }
  | { readonly kind: "ready"; readonly map: LoadedMap };

/** The part of `fetch` the loader uses, so tests can pass their own. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

class UnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreachableError";
  }
}

/** Marks a file the server doesn't have (HTTP 404 or 410). */
const MISSING = Symbol("missing");

/** Fetches and parses one JSON file. Throws UnreachableError, or DataShapeError for non-JSON. */
async function fetchJson(
  fetchFn: FetchLike,
  url: string,
  file: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { signal, headers: { Accept: "application/json" } });
  } catch (error) {
    throw new UnreachableError(
      `${file}: ${error instanceof Error ? error.message : "no response"}`,
    );
  }
  if (response.status === 404 || response.status === 410) return MISSING;
  if (!response.ok) throw new UnreachableError(`${file}: HTTP ${response.status}`);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new UnreachableError(
      `${file}: the response broke off (${error instanceof Error ? error.message : "no body"})`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A host or proxy that answers every path with the app's index.html sends HTML here.
    const html = /^\s*</.test(text);
    throw new DataShapeError(file, html ? "got an HTML page, not JSON" : "is not JSON");
  }
}

/** status.json, narrowed later; anything but a readable file counts as no entries. */
async function fetchStatus(
  fetchFn: FetchLike,
  url: string,
  signal: AbortSignal | undefined,
  warnings: string[],
): Promise<StatusOverlay> {
  try {
    const value = await fetchJson(fetchFn, url, "status.json", signal);
    return value === MISSING ? emptyStatus() : parseStatus(value);
  } catch (error) {
    if (signal?.aborted) throw error;
    warnings.push(`${error instanceof Error ? error.message : String(error)}; no closures shown`);
    return emptyStatus();
  }
}

/** The checks across features, as warnings: they don't stop the map from drawing. */
function crossChecks(indoor: IndoorSnapshot, street: StreetSnapshot): string[] {
  try {
    return [
      ...checkIndoorSnapshot(indoor).map((problem) => `indoor.json: ${problem}`),
      ...checkStreetSnapshot(street).map((problem) => `street.json: ${problem}`),
      ...checkStreetConnectors(indoor, street).map((problem) => `street connectors: ${problem}`),
    ];
  } catch (error) {
    return [`the checks across features failed: ${String(error)}`];
  }
}

export interface LoadOptions {
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}

/**
 * Loads the current version from the root of the public files (see `publicRoot`). Never rejects
 * unless `signal` aborts: every failure becomes a DataState.
 */
export async function loadMap(root: URL, options: LoadOptions = {}): Promise<DataState> {
  const fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  const { signal } = options;
  try {
    const latestJsonUrl = latestUrl(root);
    const latestValue = await fetchJson(fetchFn, latestJsonUrl, "latest.json", signal);
    if (latestValue === MISSING) return { kind: "no-version" };
    const latest = parseLatest(latestValue);
    const urls = versionFileUrls(latest, latestJsonUrl);
    const warnings: string[] = [];
    const [indoorValue, streetValue, status] = await Promise.all([
      fetchJson(fetchFn, urls.indoor, "indoor.json", signal),
      fetchJson(fetchFn, urls.street, "street.json", signal),
      fetchStatus(fetchFn, statusUrl(root), signal, warnings),
    ]);
    if (indoorValue === MISSING || streetValue === MISSING) {
      const missing = indoorValue === MISSING ? "indoor.json" : "street.json";
      return {
        kind: "invalid",
        detail: `latest.json points to version ${latest.version}, but its ${missing} is missing`,
        outdated: false,
      };
    }
    const indoor = parseIndoor(indoorValue);
    const street = parseStreet(streetValue);
    warnings.push(...crossChecks(indoor, street));
    return {
      kind: "ready",
      map: {
        latest,
        indoor,
        street,
        status: statusForVersion(status, indoor),
        urls,
        warnings,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof UnreachableError) return { kind: "unreachable", detail: error.message };
    if (error instanceof DataShapeError) {
      return {
        kind: "invalid",
        detail: error.message,
        outdated: error instanceof UnsupportedFormatError,
      };
    }
    return { kind: "invalid", detail: String(error), outdated: false };
  }
}
