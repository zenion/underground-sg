// The settings that are written down in more than one place stay in step: the PostGIS image
// in docker-compose.yml and in CI, and the values in .env.example.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, test } from "vitest";
import { REPO_ROOT } from "../../src/config.ts";

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const compose = read("docker-compose.yml");
const ci = read(".github/workflows/ci.yml");
const env = parseEnv(read(".env.example"));

function images(yaml: string, repository: string): string[] {
  return [...yaml.matchAll(new RegExp(`^\\s*image: (${repository}:\\S+)$`, "gm"))].map((match) =>
    String(match[1]),
  );
}

describe("the PostGIS image", () => {
  test("CI's service container runs the image docker-compose.yml runs", () => {
    const local = images(compose, "postgis/postgis");
    expect(local).toHaveLength(1);
    expect(images(ci, "postgis/postgis")).toEqual(local);
  });

  test("is postgis/postgis:18-3.6, pinned by digest", () => {
    expect(images(compose, "postgis/postgis")[0]).toMatch(
      /^postgis\/postgis:18-3\.6@sha256:[0-9a-f]{64}$/,
    );
  });
});

describe(".env.example", () => {
  test("defines every variable docker-compose.yml reads", () => {
    const used = [...compose.matchAll(/\$\{([A-Z0-9_]+)/g)].map((match) => String(match[1]));
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(env, name).toHaveProperty(name);
  });

  test("DATABASE_URL matches the PostGIS user, password and port", () => {
    const url = new URL(String(env["DATABASE_URL"]));
    expect(url.username).toBe(env["POSTGRES_USER"]);
    expect(decodeURIComponent(url.password)).toBe(env["POSTGRES_PASSWORD"]);
    expect(url.hostname).toBe("localhost");
    expect(url.port).toBe(env["POSTGRES_PORT"]);
  });

  test("keeps the host ports below Windows' dynamic range, where Hyper-V reserves blocks", () => {
    const ports = [...compose.matchAll(/^\s*- 127\.0\.0\.1:\$\{([A-Z0-9_]+)/gm)].map((match) =>
      String(match[1]),
    );
    expect(ports).toEqual(["POSTGRES_PORT", "RUSTFS_PORT", "RUSTFS_CONSOLE_PORT"]);
    for (const name of ports) {
      const port = Number(env[name]);
      expect(port, name).toBeGreaterThan(1024);
      expect(port, name).toBeLessThan(49152);
    }
  });

  test("S3_ENDPOINT points at RustFS's S3 port", () => {
    const url = new URL(String(env["S3_ENDPOINT"]));
    expect(url.port).toBe(env["RUSTFS_PORT"]);
  });

  test("names the three buckets", () => {
    expect(env).toMatchObject({
      S3_BUCKET_BUNDLES: expect.any(String),
      S3_BUCKET_EXPORTS: expect.any(String),
      S3_BUCKET_PUBLIC: expect.any(String),
    });
  });
});
