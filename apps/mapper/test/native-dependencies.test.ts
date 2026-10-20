// The native-dependency allow-list (ADR 0010, "Native dependencies"): every package autolinking
// links into the iOS app, Expo modules and React Native libraries alike, must be reviewed in
// native-dependencies.json, and the refused ones (packages that write images, snapshot views or
// write to the Photos library) must never be linked. Asks Expo's own autolinking, so transitive
// native dependencies count too.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const APP = fileURLToPath(new URL("../", import.meta.url));

interface AllowList {
  readonly allowed: Record<string, string>;
  readonly refused: Record<string, string>;
}

const list = JSON.parse(readFileSync(join(APP, "native-dependencies.json"), "utf8")) as AllowList;

function autolinking(...args: string[]): unknown {
  const require = createRequire(join(APP, "package.json"));
  const expo = require.resolve("expo/package.json");
  const pkg = createRequire(expo).resolve("expo-modules-autolinking/package.json");
  const out = execFileSync(
    process.execPath,
    [join(dirname(pkg), "bin", "expo-modules-autolinking.js"), ...args],
    { cwd: APP, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function linkedPackages(): string[] {
  const expo = autolinking("resolve", "--platform", "apple", "--json") as {
    modules: { packageName: string; pods: unknown[] }[];
  };
  const reactNative = autolinking("react-native-config", "--platform", "ios", "--json") as {
    dependencies: Record<string, { platforms: { ios?: unknown } }>;
  };
  const names = new Set<string>();
  for (const module of expo.modules) if (module.pods.length > 0) names.add(module.packageName);
  for (const [name, dependency] of Object.entries(reactNative.dependencies)) {
    if (dependency.platforms.ios) names.add(name);
  }
  return [...names].sort();
}

test("every natively linked package is on the allow-list, and none is refused", () => {
  const linked = linkedPackages();
  expect(linked).toContain("capture-native");
  const refused = linked.filter((name) => name in list.refused);
  expect(refused, "refused native packages are linked (ADR 0010)").toEqual([]);
  const unreviewed = linked.filter((name) => !(name in list.allowed));
  expect(unreviewed, "add these to native-dependencies.json after review").toEqual([]);
  const stale = Object.keys(list.allowed).filter((name) => !linked.includes(name));
  expect(stale, "no longer linked: remove them from native-dependencies.json").toEqual([]);
}, 60_000);

test("the lists don't overlap", () => {
  const both = Object.keys(list.allowed).filter((name) => name in list.refused);
  expect(both).toEqual([]);
});
