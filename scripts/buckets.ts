// Creates the local buckets on RustFS (docker-compose.yml) unless they exist: `pnpm buckets`.
// Safe to run again. Settings come from the root .env (copy .env.example) or the environment.

import {
  CreateBucketCommand,
  HeadBucketCommand,
  NotFound,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { loadRootEnv, required } from "./env.ts";
import { unreachableMessage } from "./errors.ts";

/** Each bucket's variable and what it holds (docs/decisions/0004 and 0009). */
const BUCKETS = [
  ["S3_BUCKET_BUNDLES", "raw capture bundles (private)"],
  ["S3_BUCKET_EXPORTS", "full exports of HEAD for rollback (private)"],
  [
    "S3_BUCKET_PUBLIC",
    "public map files: versioned indoor.json and street.json, latest.json, status.json",
  ],
] as const;

loadRootEnv();
const endpoint = required("S3_ENDPOINT");
const client = new S3Client({
  endpoint,
  region: required("S3_REGION"),
  // RustFS serves buckets as paths (http://host:port/bucket), not as subdomains.
  forcePathStyle: true,
  credentials: {
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  },
});

async function exists(bucket: string): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (error) {
    if (error instanceof NotFound) return false;
    if (error instanceof S3ServiceException) {
      const status = error.$metadata.httpStatusCode;
      if (status === 404) return false;
      if (status === 403) {
        throw new Error(
          `${bucket}: access denied. Check that S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY match ` +
            "the rustfs container's; after changing them, `docker compose up -d` recreates it.",
        );
      }
    }
    throw error;
  }
}

try {
  for (const [variable, contents] of BUCKETS) {
    const bucket = required(variable);
    if (await exists(bucket)) {
      console.log(`${bucket}: exists (${contents})`);
    } else {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`${bucket}: created (${contents})`);
    }
  }
} catch (error) {
  // The SDK's own error is a nested AggregateError that names neither the endpoint nor the fix.
  const message = unreachableMessage(error, [
    { name: "RustFS", variable: "S3_ENDPOINT", url: endpoint },
  ]);
  if (message === undefined) throw error;
  console.error(message);
  process.exitCode = 1;
} finally {
  client.destroy();
}
