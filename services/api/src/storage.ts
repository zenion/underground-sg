// Object storage through the S3 API: RustFS on the owner's PC through Phase 3, S3 in
// ap-southeast-1 (private buckets) and Cloudflare R2 (public files) from Phase 4
// (docs/decisions/0009-hosting-and-budget.md). `ObjectStore` is one bucket; tests use
// `MemoryObjectStore` where they don't need the real service.
//
// Objects are small map files here (the public files and the private exports). Bodies are read as
// streams and written from memory; nothing goes through a temp file (docs/decisions/0005). There
// is deliberately no delete: a version's directory is never overwritten or deleted.

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { BucketNames, S3Config } from "./config.ts";

/** What a store knows about an object besides its bytes. */
export interface ObjectMetadata {
  readonly contentType: string | undefined;
  /** The stored `Content-Encoding`, such as `br` for a version file; undefined when identity. */
  readonly contentEncoding: string | undefined;
  readonly cacheControl: string | undefined;
  /** Size of the stored bytes (encoded, if the object has a content encoding). */
  readonly contentLength: number | undefined;
  /** The entity tag, quoted, as S3 sends it. */
  readonly etag: string | undefined;
  readonly lastModified: Date | undefined;
}

export interface StoredObject extends ObjectMetadata {
  /** The stored bytes, as stored (still encoded). Consume or destroy it. */
  readonly body: Readable;
}

export interface PutObjectOptions {
  readonly contentType: string;
  readonly contentEncoding?: string;
  readonly cacheControl?: string;
}

/** One bucket. */
export interface ObjectStore {
  /** The bucket's name, for logs. */
  readonly bucket: string;
  /** The object, or undefined if there is none with that key. */
  get(key: string, signal?: AbortSignal): Promise<StoredObject | undefined>;
  /** The object's metadata, or undefined if there is none with that key. */
  head(key: string, signal?: AbortSignal): Promise<ObjectMetadata | undefined>;
  /** Writes an object, replacing any with that key. */
  put(key: string, body: Uint8Array, options: PutObjectOptions): Promise<void>;
  /** Whether the bucket exists and answers. Throws when the service can't be reached. */
  exists(signal?: AbortSignal): Promise<boolean>;
}

/** The three buckets, by role, and what the service says about itself. */
export interface Storage {
  readonly buckets: { readonly [Role in keyof BucketNames]: ObjectStore };
  /** The service's version, when it reports one (RustFS's /health does), else undefined. */
  serverVersion(signal?: AbortSignal): Promise<string | undefined>;
  close(): void;
}

/** True when the error says the object or bucket isn't there. */
function isNotFound(error: unknown): boolean {
  if (error instanceof NoSuchKey || error instanceof NotFound) return true;
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;
}

function metadata(output: {
  ContentType?: string | undefined;
  ContentEncoding?: string | undefined;
  CacheControl?: string | undefined;
  ContentLength?: number | undefined;
  ETag?: string | undefined;
  LastModified?: Date | undefined;
}): ObjectMetadata {
  const encoding = output.ContentEncoding?.trim().toLowerCase();
  return {
    contentType: output.ContentType,
    contentEncoding: encoding === "" || encoding === "identity" ? undefined : encoding,
    cacheControl: output.CacheControl,
    contentLength: output.ContentLength,
    etag: output.ETag,
    lastModified: output.LastModified,
  };
}

export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly bucket: string;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.bucket = bucket;
  }

  async get(key: string, signal?: AbortSignal): Promise<StoredObject | undefined> {
    try {
      const output = await this.#client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: signal },
      );
      const body = output.Body;
      if (!(body instanceof Readable)) throw new Error(`GetObject ${key}: no readable body`);
      return { ...metadata(output), body };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async head(key: string, signal?: AbortSignal): Promise<ObjectMetadata | undefined> {
    try {
      const output = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: signal },
      );
      return metadata(output);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async put(key: string, body: Uint8Array, options: PutObjectOptions): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.byteLength,
        ContentType: options.contentType,
        ContentEncoding: options.contentEncoding,
        CacheControl: options.cacheControl,
      }),
    );
  }

  async exists(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
        abortSignal: signal,
      });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}

/**
 * Limits on every S3 request. The SDK's defaults are none at all, so an endpoint that accepts a
 * connection and never answers (Docker Desktop paused, a stuck RustFS, a stalled link to R2) would
 * hang a request, and a publish holding map_head's lock, for ever.
 */
export interface S3Timeouts {
  /** How long connecting may take. */
  readonly connectionMs: number;
  /**
   * How long a request and its response may take, a version file's upload included. A version
   * file is at most a few MB once brotli-compressed, so this leaves room for a slow upload to R2.
   */
  readonly requestMs: number;
}

export const DEFAULT_S3_TIMEOUTS: S3Timeouts = { connectionMs: 3_000, requestMs: 30_000 };

/** An S3 client for RustFS (path-style buckets) or any other S3 endpoint. */
export function createS3Client(
  config: S3Config,
  timeouts: S3Timeouts = DEFAULT_S3_TIMEOUTS,
): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    // RustFS serves buckets as paths (http://host:port/bucket), not as subdomains.
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Checksums only where S3 requires them: S3-compatible stores differ in which of the newer
    // flexible checksums they accept.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 2,
    requestHandler: {
      connectionTimeout: timeouts.connectionMs,
      requestTimeout: timeouts.requestMs,
      // Without it a request past requestTimeout only logs a warning and carries on waiting.
      throwOnRequestTimeout: true,
    },
  });
}

/** The service's version from RustFS's `/health` (`{"version": "1.0.1", ...}`), if it has one. */
async function healthVersion(endpoint: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/health", endpoint), {
      signal: signal ?? AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version.length <= 100
      ? body.version
      : undefined;
  } catch {
    return undefined;
  }
}

/** The three buckets on one S3 endpoint. */
export function createS3Storage(
  config: S3Config,
  buckets: BucketNames,
  timeouts: S3Timeouts = DEFAULT_S3_TIMEOUTS,
): Storage {
  const client = createS3Client(config, timeouts);
  return {
    buckets: {
      bundles: new S3ObjectStore(client, buckets.bundles),
      exports: new S3ObjectStore(client, buckets.exports),
      public: new S3ObjectStore(client, buckets.public),
    },
    serverVersion: (signal) => healthVersion(config.endpoint, signal),
    close: () => client.destroy(),
  };
}

interface MemoryObject extends Omit<ObjectMetadata, "contentLength"> {
  readonly bytes: Uint8Array;
}

/** A bucket in memory, for tests. */
export class MemoryObjectStore implements ObjectStore {
  readonly bucket: string;
  readonly #objects = new Map<string, MemoryObject>();

  constructor(bucket = "memory") {
    this.bucket = bucket;
  }

  /** The keys stored, sorted. */
  keys(): string[] {
    return [...this.#objects.keys()].sort();
  }

  async get(key: string): Promise<StoredObject | undefined> {
    const object = this.#objects.get(key);
    if (object === undefined) return undefined;
    return {
      ...this.#metadata(object),
      body: Readable.from([Buffer.from(object.bytes)], { objectMode: false }),
    };
  }

  async head(key: string): Promise<ObjectMetadata | undefined> {
    const object = this.#objects.get(key);
    return object === undefined ? undefined : this.#metadata(object);
  }

  async put(key: string, body: Uint8Array, options: PutObjectOptions): Promise<void> {
    const bytes = new Uint8Array(body);
    this.#objects.set(key, {
      bytes,
      contentType: options.contentType,
      contentEncoding: options.contentEncoding,
      cacheControl: options.cacheControl,
      etag: `"${createHash("md5").update(bytes).digest("hex")}"`,
      lastModified: new Date(),
    });
  }

  async exists(): Promise<boolean> {
    return true;
  }

  #metadata(object: MemoryObject): ObjectMetadata {
    const { bytes, ...rest } = object;
    return { ...rest, contentLength: bytes.byteLength };
  }
}

/** Three in-memory buckets, for tests. */
export function createMemoryStorage(serverVersion?: string): Storage {
  return {
    buckets: {
      bundles: new MemoryObjectStore("bundles"),
      exports: new MemoryObjectStore("exports"),
      public: new MemoryObjectStore("public"),
    },
    serverVersion: async () => serverVersion,
    close: () => {},
  };
}
