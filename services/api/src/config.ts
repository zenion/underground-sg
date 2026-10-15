// The API's settings, from the environment. server.ts loads the root .env first (loadRootEnv from
// @usg/scripts/env), so variables already set in the environment win. Errors name the variable,
// never its value: some of these are credentials.

import { required } from "@usg/scripts/env";
import type { StackService } from "@usg/scripts/errors";

export interface S3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** The buckets, by role (docs/decisions/0009-hosting-and-budget.md). */
export interface BucketNames {
  /** Raw capture bundles. Private. */
  readonly bundles: string;
  /** Private full exports of HEAD, for rollback. */
  readonly exports: string;
  /** The public map files. */
  readonly public: string;
}

/** What the API, the publish CLI and the demo share: the database, the S3 endpoint, the buckets. */
export interface StackConfig {
  readonly databaseUrl: string;
  readonly s3: S3Config;
  readonly buckets: BucketNames;
}

export interface ApiConfig extends StackConfig {
  /** The address to listen on: 127.0.0.1 by default; 0.0.0.0 to let the phone reach it on the LAN. */
  readonly host: string;
  readonly port: number;
  /** Origins allowed to read responses from a browser or WebView (CORS). */
  readonly corsOrigins: readonly string[];
  /**
   * Where the public files are served, ending in `/` (Cloudflare R2's public URL in production),
   * or undefined to point clients at this API's `GET /public/`.
   */
  readonly publicFilesUrl: string | undefined;
}

export const DEFAULT_HOST = "127.0.0.1";
/** Below 49152: Windows reserves blocks of the dynamic range when WSL2 or Hyper-V runs. */
export const DEFAULT_PORT = 28000;
/** The Vite dev server (apps/web) and Metro, which serves the mapper app's DOM components. */
export const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
] as const;

export class ConfigError extends Error {
  override name = "ConfigError";
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function port(env: NodeJS.ProcessEnv): number {
  const value = optional(env, "API_PORT");
  if (value === undefined) return DEFAULT_PORT;
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || parsed < 1 || parsed > 65_535) {
    throw new ConfigError("API_PORT must be a port number from 1 to 65535");
  }
  return parsed;
}

/** An http(s) origin as the browser sends it: scheme, host and port, no path. */
function origin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must list origins such as http://localhost:5173`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) {
    throw new ConfigError(`${name} must list origins such as http://localhost:5173, without paths`);
  }
  return value;
}

function corsOrigins(env: NodeJS.ProcessEnv): string[] {
  const value = optional(env, "API_CORS_ORIGINS");
  if (value === undefined) return [...DEFAULT_CORS_ORIGINS];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => origin(item, "API_CORS_ORIGINS"));
}

function publicFilesUrl(env: NodeJS.ProcessEnv): string | undefined {
  const value = optional(env, "API_PUBLIC_FILES_URL");
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("API_PUBLIC_FILES_URL must be an http or https URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.search !== "" || url.hash !== "") {
    throw new ConfigError("API_PUBLIC_FILES_URL must be an http or https URL without a query");
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  try {
    return required(name, env);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
}

/** Reads the database, S3 and bucket settings from `env` (by default the process environment). */
export function loadStackConfig(env: NodeJS.ProcessEnv = process.env): StackConfig {
  return {
    databaseUrl: need(env, "DATABASE_URL"),
    s3: {
      endpoint: need(env, "S3_ENDPOINT"),
      region: need(env, "S3_REGION"),
      accessKeyId: need(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: need(env, "S3_SECRET_ACCESS_KEY"),
    },
    buckets: {
      bundles: need(env, "S3_BUCKET_BUNDLES"),
      exports: need(env, "S3_BUCKET_EXPORTS"),
      public: need(env, "S3_BUCKET_PUBLIC"),
    },
  };
}

/** The stack's services, for messages about one that isn't listening (unreachableMessage). */
export function stackServices(config: Pick<StackConfig, "databaseUrl" | "s3">): StackService[] {
  return [
    { name: "PostGIS", variable: "DATABASE_URL", url: config.databaseUrl },
    { name: "RustFS", variable: "S3_ENDPOINT", url: config.s3.endpoint },
  ];
}

/**
 * The API's address for printing a URL to it (`pnpm demo`): API_HOST and API_PORT, falling back to
 * the defaults when they are missing or malformed, since only `pnpm api` needs them right.
 */
export function apiAddressForDisplay(env: NodeJS.ProcessEnv = process.env): string {
  const host = optional(env, "API_HOST") ?? DEFAULT_HOST;
  let listen: number;
  try {
    listen = port(env);
  } catch {
    listen = DEFAULT_PORT;
  }
  // Listening on every address: this machine's loopback reaches it.
  const reachable = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const shown =
    reachable.includes(":") && !reachable.startsWith("[") ? `[${reachable}]` : reachable;
  return `http://${shown}:${listen}`;
}

/** Reads the API's settings from `env` (by default the process environment). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    host: optional(env, "API_HOST") ?? DEFAULT_HOST,
    port: port(env),
    corsOrigins: corsOrigins(env),
    publicFilesUrl: publicFilesUrl(env),
    ...loadStackConfig(env),
  };
}

/** True for a host name on this machine (loopback): `localhost`, 127.0.0.0/8 or `::1`. */
export { isLoopbackHost } from "@usg/db/local";
