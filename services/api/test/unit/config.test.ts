import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, test } from "vitest";
import {
  apiAddressForDisplay,
  ConfigError,
  DEFAULT_CORS_ORIGINS,
  DEFAULT_PORT,
  isLoopbackHost,
  loadConfig,
  loadStackConfig,
} from "../../src/config.ts";

const exampleText = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8");
const example = parseEnv(exampleText) as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  test(".env.example gives a complete configuration on 127.0.0.1:28000", () => {
    const config = loadConfig(example);
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 28000,
      corsOrigins: [...DEFAULT_CORS_ORIGINS],
      publicFilesUrl: undefined,
      buckets: { bundles: "usg-bundles", exports: "usg-exports", public: "usg-public" },
    });
  });

  test("defaults: loopback only, port 28000, the Vite and Metro origins", () => {
    const { API_HOST, API_PORT, API_CORS_ORIGINS, ...rest } = example;
    const config = loadConfig(rest);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.corsOrigins).toEqual([...DEFAULT_CORS_ORIGINS]);
  });

  test("API_WEB_DIST: unset or empty serves no page; a path is made absolute", () => {
    expect(loadConfig(example).webDist).toBeUndefined();
    expect(loadConfig({ ...example, API_WEB_DIST: " " }).webDist).toBeUndefined();
    const dist = loadConfig({ ...example, API_WEB_DIST: "apps/web/dist" }).webDist;
    expect(dist).toBe(resolve("apps/web/dist"));
    expect(isAbsolute(String(dist))).toBe(true);
  });

  test(".env.example's API port stays below Windows' dynamic port range", () => {
    expect(Number(example["API_PORT"])).toBeLessThan(49152);
    expect(DEFAULT_PORT).toBeLessThan(49152);
  });

  test("reads the LAN settings", () => {
    const config = loadConfig({
      ...example,
      API_HOST: "0.0.0.0",
      API_PORT: "28080",
      API_CORS_ORIGINS: "http://192.168.1.20:8081, http://localhost:5173",
      API_PUBLIC_FILES_URL: "https://maps.example.org/public",
    });
    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 28080,
      corsOrigins: ["http://192.168.1.20:8081", "http://localhost:5173"],
      publicFilesUrl: "https://maps.example.org/public/",
    });
  });

  test.each([
    ["API_PORT", "0"],
    ["API_PORT", "65536"],
    ["API_PORT", "28000x"],
    ["API_CORS_ORIGINS", "http://localhost:5173/app"],
    ["API_CORS_ORIGINS", "localhost:5173"],
    ["API_PUBLIC_FILES_URL", "ftp://example.org/"],
    ["API_PUBLIC_FILES_URL", "https://example.org/?token=x"],
  ])("refuses %s=%s", (name, value) => {
    expect(() => loadConfig({ ...example, [name]: value })).toThrow(ConfigError);
  });

  test("a missing setting is named, and no value is ever echoed", () => {
    const { S3_SECRET_ACCESS_KEY, ...rest } = example;
    expect(() => loadConfig(rest)).toThrow(/S3_SECRET_ACCESS_KEY is not set/);
    const error = (() => {
      try {
        loadConfig({ ...example, API_PORT: "not-a-port-secret" });
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error?.message).not.toContain("not-a-port-secret");
  });
});

describe("loadStackConfig", () => {
  test("reads only the database, S3 and bucket settings, which the CLIs need", () => {
    const { API_HOST, API_PORT, API_CORS_ORIGINS, API_PUBLIC_FILES_URL, API_WEB_DIST, ...rest } =
      example;
    expect(loadStackConfig(rest)).toEqual({
      databaseUrl: example["DATABASE_URL"],
      s3: {
        endpoint: example["S3_ENDPOINT"],
        region: example["S3_REGION"],
        accessKeyId: example["S3_ACCESS_KEY_ID"],
        secretAccessKey: example["S3_SECRET_ACCESS_KEY"],
      },
      buckets: { bundles: "usg-bundles", exports: "usg-exports", public: "usg-public" },
    });
  });
});

describe("apiAddressForDisplay", () => {
  test("API_HOST and API_PORT, with this machine's loopback for an address that listens on all", () => {
    expect(apiAddressForDisplay({})).toBe("http://127.0.0.1:28000");
    expect(apiAddressForDisplay({ API_HOST: "0.0.0.0", API_PORT: "28010" })).toBe(
      "http://127.0.0.1:28010",
    );
    expect(apiAddressForDisplay({ API_HOST: "::" })).toBe("http://[::1]:28000");
  });

  test("the defaults when a setting the demo doesn't need is malformed", () => {
    expect(
      apiAddressForDisplay({ API_PORT: "not-a-port", API_CORS_ORIGINS: "localhost:5173" }),
    ).toBe("http://127.0.0.1:28000");
  });
});

describe("isLoopbackHost", () => {
  test.each(["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "[::1]", "::1"])(
    "%s is",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  test.each([
    "0.0.0.0",
    "192.168.1.20",
    "10.0.0.1",
    "example.com",
    "localhost.example.com",
    "127.0.0.1.nip.io",
  ])("%s isn't", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
