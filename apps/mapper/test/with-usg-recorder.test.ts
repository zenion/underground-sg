// The session recorder's build switch (plugins/with-usg-recorder.ts; the lean recorder design,
// section 2): without USG_RECORDER=1 nothing is set and the switch is removed; the location key
// only in the walk build; LSSupportsOpeningDocumentsInPlace never; a bad profile throws; the git
// commit and EAS build id only when they are well formed. The last tests run the plugin's mods
// the way prebuild does, on a stale Info.plist and Podfile.properties.json.

import type { ExpoConfig } from "expo/config";
import type { ExportedConfig } from "expo/config-plugins";
import { describe, expect, test } from "vitest";
import withUsgRecorder, {
  applyInfoPlist,
  applyPodfileProperties,
  NEVER_SET_INFO_PLIST_KEYS,
  RECORDER_INFO_PLIST_KEYS,
  RECORDER_PODFILE_PROPERTY,
  type RecorderEnv,
  recorderSettings,
} from "../plugins/with-usg-recorder.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const EAS_BUILD_ID = "3f2c1a9e-7b4d-4c1e-9a2b-5d6e7f809a1b";

const walk = { USG_RECORDER: "1", USG_BUILD_PROFILE: "walk" };
const development = { USG_RECORDER: "1", USG_BUILD_PROFILE: "development" };

describe("recorderSettings", () => {
  test.each<[string, RecorderEnv]>([
    ["unset", {}],
    ["empty", { USG_RECORDER: "" }],
    ["0", { USG_RECORDER: "0" }],
    ["0 with an empty profile", { USG_RECORDER: "0", USG_BUILD_PROFILE: "" }],
  ])("is off when USG_RECORDER is %s", (_, env) => {
    expect(recorderSettings(env)).toBeNull();
  });

  test("sets the switch, the recorder's keys and the profile in both builds", () => {
    for (const env of [walk, development]) {
      const settings = recorderSettings(env);
      expect(settings?.profile).toBe(env.USG_BUILD_PROFILE);
      expect(settings?.podfileProperties).toEqual({ [RECORDER_PODFILE_PROPERTY]: "true" });
      expect(settings?.infoPlist["UIFileSharingEnabled"]).toBe(true);
      expect(settings?.infoPlist["NSMotionUsageDescription"]).toEqual(expect.any(String));
      expect(settings?.infoPlist["USGBuildProfile"]).toBe(env.USG_BUILD_PROFILE);
    }
  });

  test("puts the location usage key only in the walk build (D14)", () => {
    expect(recorderSettings(walk)?.infoPlist["NSLocationWhenInUseUsageDescription"]).toEqual(
      expect.any(String),
    );
    expect(recorderSettings(development)?.infoPlist).not.toHaveProperty(
      "NSLocationWhenInUseUsageDescription",
    );
  });

  test("never sets LSSupportsOpeningDocumentsInPlace (D24)", () => {
    for (const env of [walk, development]) {
      const settings = recorderSettings({ ...env, GITHUB_SHA: COMMIT, EAS_BUILD_ID });
      expect(settings?.infoPlist).not.toHaveProperty("LSSupportsOpeningDocumentsInPlace");
    }
  });

  test("sets only keys the switch owns", () => {
    const settings = recorderSettings({ ...walk, EAS_BUILD_GIT_COMMIT_HASH: COMMIT, EAS_BUILD_ID });
    const owned: readonly string[] = RECORDER_INFO_PLIST_KEYS;
    expect(Object.keys(settings?.infoPlist ?? {}).every((key) => owned.includes(key))).toBe(true);
    expect(Object.keys(settings?.infoPlist ?? {}).sort()).toEqual([...owned].sort());
  });

  test.each<[string, RecorderEnv]>([
    ["no profile", { USG_RECORDER: "1" }],
    ["an empty profile", { USG_RECORDER: "1", USG_BUILD_PROFILE: "" }],
    ["an unknown profile", { USG_RECORDER: "1", USG_BUILD_PROFILE: "production" }],
    ["a profile in the wrong case", { USG_RECORDER: "1", USG_BUILD_PROFILE: "Walk" }],
  ])("throws with USG_RECORDER=1 and %s", (_, env) => {
    expect(() => recorderSettings(env)).toThrow(/USG_BUILD_PROFILE/);
  });

  test("throws on a switch value it doesn't know", () => {
    for (const value of ["true", "yes", "2", " 1"]) {
      expect(() => recorderSettings({ USG_RECORDER: value, USG_BUILD_PROFILE: "walk" })).toThrow(
        /USG_RECORDER must be/,
      );
    }
  });

  test("throws on a profile without the switch, rather than build a walk build without it", () => {
    expect(() => recorderSettings({ USG_BUILD_PROFILE: "walk" })).toThrow(/without USG_RECORDER/);
    expect(() => recorderSettings({ USG_RECORDER: "0", USG_BUILD_PROFILE: "walk" })).toThrow();
  });

  test("never puts the value it refused in the message", () => {
    expect(() => recorderSettings({ USG_RECORDER: "1", USG_BUILD_PROFILE: "secret-x" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret-x") }),
    );
  });

  describe("USGGitCommit", () => {
    const commitOf = (env: RecorderEnv) => recorderSettings({ ...walk, ...env })?.infoPlist;

    test("takes EAS Build's commit first, then GitHub's", () => {
      const other = "f".repeat(40);
      expect(commitOf({ EAS_BUILD_GIT_COMMIT_HASH: COMMIT, GITHUB_SHA: other })).toHaveProperty(
        "USGGitCommit",
        COMMIT,
      );
      expect(commitOf({ GITHUB_SHA: other })).toHaveProperty("USGGitCommit", other);
      expect(commitOf({ EAS_BUILD_GIT_COMMIT_HASH: "", GITHUB_SHA: other })).toHaveProperty(
        "USGGitCommit",
        other,
      );
    });

    test.each([
      ["uppercase", COMMIT.toUpperCase()],
      ["short", COMMIT.slice(0, 39)],
      ["long", `${COMMIT}0`],
      ["abbreviated", COMMIT.slice(0, 7)],
      ["not hex", `${COMMIT.slice(0, 39)}g`],
      ["with a newline", `${COMMIT}\n`],
    ])("is left out when it is %s", (_, value) => {
      expect(commitOf({ EAS_BUILD_GIT_COMMIT_HASH: value })).not.toHaveProperty("USGGitCommit");
    });

    test("is left out without either variable", () => {
      expect(commitOf({})).not.toHaveProperty("USGGitCommit");
    });
  });

  describe("USGEasBuildId", () => {
    const idOf = (value: string) => recorderSettings({ ...walk, EAS_BUILD_ID: value })?.infoPlist;

    test("is EAS_BUILD_ID when it is a UUID", () => {
      expect(idOf(EAS_BUILD_ID)).toHaveProperty("USGEasBuildId", EAS_BUILD_ID);
    });

    test.each([
      ["uppercase", EAS_BUILD_ID.toUpperCase()],
      ["without hyphens", EAS_BUILD_ID.replaceAll("-", "")],
      ["in braces", `{${EAS_BUILD_ID}}`],
      ["truncated", EAS_BUILD_ID.slice(0, -1)],
      ["not hex", `${EAS_BUILD_ID.slice(0, -1)}z`],
      ["empty", ""],
    ])("is left out when it is %s", (_, value) => {
      expect(idOf(value)).not.toHaveProperty("USGEasBuildId");
    });
  });
});

describe("applyInfoPlist and applyPodfileProperties", () => {
  const stalePlist = {
    CFBundleDisplayName: "Underground SG Mapper",
    UIFileSharingEnabled: true,
    NSMotionUsageDescription: "stale",
    NSLocationWhenInUseUsageDescription: "stale",
    USGBuildProfile: "walk",
    USGGitCommit: COMMIT,
    USGEasBuildId: EAS_BUILD_ID,
    LSSupportsOpeningDocumentsInPlace: true,
  };

  test("off removes every key the switch owns and keeps the rest", () => {
    expect(applyInfoPlist(stalePlist, null)).toEqual({
      CFBundleDisplayName: "Underground SG Mapper",
    });
    expect(
      applyPodfileProperties(
        { [RECORDER_PODFILE_PROPERTY]: "true", "expo.jsEngine": "hermes" },
        null,
      ),
    ).toEqual({ "expo.jsEngine": "hermes" });
  });

  test("the development build drops a walk build's location key and the never-set key", () => {
    const plist = applyInfoPlist(stalePlist, recorderSettings(development));
    expect(plist).not.toHaveProperty("NSLocationWhenInUseUsageDescription");
    expect(plist).not.toHaveProperty("LSSupportsOpeningDocumentsInPlace");
    expect(plist).not.toHaveProperty("USGGitCommit");
    expect(plist).toHaveProperty("USGBuildProfile", "development");
    expect(plist).toHaveProperty("CFBundleDisplayName", "Underground SG Mapper");
  });

  test("on sets the property", () => {
    expect(applyPodfileProperties({}, recorderSettings(walk))).toEqual({
      [RECORDER_PODFILE_PROPERTY]: "true",
    });
  });
});

describe("the plugin", () => {
  type Mod = (config: Record<string, unknown>) => Promise<{ modResults: unknown }>;

  /** Runs the plugin's iOS mods on the given files, as prebuild does (without writing them). */
  async function prebuild(
    env: RecorderEnv,
    plist: Record<string, unknown>,
    properties: Record<string, string>,
  ) {
    const base: ExpoConfig = { name: "Underground SG Mapper", slug: "underground-sg" };
    // The mods prebuild runs are on the config the plugin returns.
    const config: ExportedConfig = withUsgRecorder(base, env);
    const mods = config.mods?.ios as Record<string, Mod> | undefined;
    const run = async (name: string, modResults: unknown) => {
      const mod = mods?.[name];
      if (!mod) throw new Error(`no ${name} mod`);
      return (await mod({ ...config, modResults, modRequest: { platform: "ios" } })).modResults;
    };
    return {
      plist: (await run("infoPlist", plist)) as Record<string, unknown>,
      properties: (await run("podfileProperties", properties)) as Record<string, string>,
    };
  }

  test("a walk build gets the switch and the walk keys", async () => {
    const out = await prebuild({ ...walk, GITHUB_SHA: COMMIT }, {}, {});
    expect(out.properties).toEqual({ [RECORDER_PODFILE_PROPERTY]: "true" });
    expect(out.plist).toMatchObject({
      UIFileSharingEnabled: true,
      USGBuildProfile: "walk",
      USGGitCommit: COMMIT,
      NSLocationWhenInUseUsageDescription: expect.any(String),
    });
  });

  test("a build without the switch removes it from a stale ios/ folder", async () => {
    const out = await prebuild(
      {},
      {
        UIFileSharingEnabled: true,
        LSSupportsOpeningDocumentsInPlace: true,
        USGBuildProfile: "walk",
      },
      { [RECORDER_PODFILE_PROPERTY]: "true", "expo.jsEngine": "hermes" },
    );
    expect(out.properties).toEqual({ "expo.jsEngine": "hermes" });
    for (const key of [...RECORDER_INFO_PLIST_KEYS, ...NEVER_SET_INFO_PLIST_KEYS]) {
      expect(out.plist).not.toHaveProperty(key);
    }
  });

  test("throws when the config is evaluated with a bad profile", () => {
    expect(() =>
      withUsgRecorder(
        { name: "x", slug: "x" },
        { USG_RECORDER: "1", USG_BUILD_PROFILE: "production" },
      ),
    ).toThrow();
  });
});
