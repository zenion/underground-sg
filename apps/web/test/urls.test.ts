import { describe, expect, test } from "vitest";
import { demoPublicFiles } from "../fixtures/demo-snapshot.ts";
import { parseLatest } from "../src/data/shapes.ts";
import {
  DEFAULT_PUBLIC_BASE,
  latestUrl,
  publicRoot,
  statusUrl,
  versionFileUrls,
} from "../src/data/urls.ts";

const SHA = "156893bdd66a965d605b96190310d51c2e662c02a3c750166a6a694e810dc282";

const latest = parseLatest({
  schema_version: 1,
  version: 7,
  published_at: "2026-11-02T14:05:11+08:00",
  snapshot_sha256: SHA,
  files: {
    indoor: { path: `snapshots/${SHA}/indoor.json`, bytes: 10, sha256: SHA },
    street: { path: `snapshots/${SHA}/street.json`, bytes: 10, sha256: SHA },
  },
  attribution: [
    { text: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" },
  ],
});

describe("publicRoot", () => {
  test.each([
    [undefined, "http://localhost:5173/", "http://localhost:5173/public/"],
    ["", "http://localhost:5173/", "http://localhost:5173/public/"],
    ["/public", "http://192.168.1.20:5173/#map=17/1.29/103.85", "http://192.168.1.20:5173/public/"],
    ["/public/", "http://localhost:5173/some/page?x=1", "http://localhost:5173/public/"],
    ["https://files.example.org/map", "http://localhost:5173/", "https://files.example.org/map/"],
    ["https://files.example.org/map/", "https://underground.sg/", "https://files.example.org/map/"],
  ])("%s on %s is %s", (base, page, expected) => {
    expect(publicRoot(base, page).href).toBe(expected);
  });

  test("the default is /public, where the API and the fixture server serve the files", () => {
    expect(DEFAULT_PUBLIC_BASE).toBe("/public");
  });
});

describe("the files' URLs", () => {
  test("latest.json and status.json sit at the root", () => {
    const root = publicRoot("/public", "http://localhost:5173/");
    expect(latestUrl(root)).toBe("http://localhost:5173/public/latest.json");
    expect(statusUrl(root)).toBe("http://localhost:5173/public/status.json");
  });

  test("a version's files resolve against latest.json, under the root", () => {
    const root = publicRoot("https://files.example.org/map", "http://localhost:5173/");
    expect(versionFileUrls(latest, latestUrl(root))).toEqual({
      indoor: `https://files.example.org/map/snapshots/${SHA}/indoor.json`,
      street: `https://files.example.org/map/snapshots/${SHA}/street.json`,
    });
  });

  test("the demo's latest.json gives the paths the fixture server serves", () => {
    const files = demoPublicFiles(new Date());
    const demo = parseLatest(JSON.parse(files.get("latest.json")?.body ?? "") as unknown);
    const root = publicRoot(undefined, "http://localhost:5173/");
    const urls = versionFileUrls(demo, latestUrl(root));
    for (const url of [urls.indoor, urls.street]) {
      expect(files.has(url.replace("http://localhost:5173/public/", ""))).toBe(true);
    }
  });
});
