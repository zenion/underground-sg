// The session recorder's build switch (ADR 0010; the lean recorder design, section 2). EAS sets
// USG_RECORDER=1 and USG_BUILD_PROFILE in the development and walk profiles of eas.json; this
// config plugin turns them into what the native build reads:
// - Podfile.properties.json "usg.recorder": "true", which modules/capture-native/usg-recorder.rb
//   turns into the USG_RECORDER Swift compilation condition of the module's pods;
// - the Info.plist keys only a build with the recorder has: UIFileSharingEnabled (the exports
//   folder over USB), NSMotionUsageDescription, USGBuildProfile (the module's RecordPermission
//   grants only "walk"), USGGitCommit and USGEasBuildId (the recording's build facts), and, in the
//   walk build only, NSLocationWhenInUseUsageDescription (D14: without it the development build
//   can't be authorised for Core Location, whatever its code does).
// Without USG_RECORDER=1 it sets none of them and removes every one, so a stale ios/ folder can't
// keep the switch. LSSupportsOpeningDocumentsInPlace is never set and always removed (D24).
//
// `recorderSettings(env)` is pure, for the tests (test/with-usg-recorder.test.ts); the plugin reads
// process.env when Expo evaluates app.config.ts (prebuild, EAS Build, `expo config`).

import { type ConfigPlugin, withInfoPlist, withPodfileProperties } from "expo/config-plugins";

export type RecorderBuildProfile = "development" | "walk";

/** The environment the switch reads; process.env in the plugin. */
export type RecorderEnv = Readonly<Record<string, string | undefined>>;

export type InfoPlistValue = string | boolean;

export interface RecorderSettings {
  readonly profile: RecorderBuildProfile;
  /** The recorder's Info.plist keys for this build; the plugin removes the others it owns. */
  readonly infoPlist: Readonly<Record<string, InfoPlistValue>>;
  readonly podfileProperties: Readonly<Record<string, string>>;
}

/** The Podfile.properties.json key usg-recorder.rb reads. */
export const RECORDER_PODFILE_PROPERTY = "usg.recorder";

/** Every Info.plist key the switch owns: set as the settings say, removed otherwise. */
export const RECORDER_INFO_PLIST_KEYS = [
  "UIFileSharingEnabled",
  "NSMotionUsageDescription",
  "NSLocationWhenInUseUsageDescription",
  "USGBuildProfile",
  "USGGitCommit",
  "USGEasBuildId",
] as const;

/** Never set by any build (D24); absent means false. */
export const NEVER_SET_INFO_PLIST_KEYS = ["LSSupportsOpeningDocumentsInPlace"] as const;

const PROFILES: readonly RecorderBuildProfile[] = ["development", "walk"];

const MOTION_USAGE =
  "The motion sensors and the barometer record how the phone moves during a mapping walk, so the walk can be rebuilt on the mapping PC.";
const LOCATION_USAGE =
  "Your location is recorded only while you face the street at an entrance during a mapping walk, to place the underground map on the street map.";

const GIT_COMMIT = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An unset or empty variable is absent. */
function read(env: RecorderEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The switch's settings for this environment, or null for a build without the recorder.
 * Throws on a value it doesn't know, so a typo fails the build instead of compiling the recorder
 * out of a walk build (the messages name the variable, never its value).
 */
export function recorderSettings(env: RecorderEnv): RecorderSettings | null {
  const recorder = read(env, "USG_RECORDER");
  const profile = read(env, "USG_BUILD_PROFILE");
  if (recorder === undefined || recorder === "0") {
    if (profile !== undefined) {
      throw new Error("USG_BUILD_PROFILE is set without USG_RECORDER=1");
    }
    return null;
  }
  if (recorder !== "1") {
    throw new Error("USG_RECORDER must be 1, 0 or unset");
  }
  if (!PROFILES.includes(profile as RecorderBuildProfile)) {
    throw new Error("USG_RECORDER=1 needs USG_BUILD_PROFILE set to development or walk");
  }
  const buildProfile = profile as RecorderBuildProfile;

  const infoPlist: Record<string, InfoPlistValue> = {
    UIFileSharingEnabled: true,
    NSMotionUsageDescription: MOTION_USAGE,
    USGBuildProfile: buildProfile,
  };
  // EAS Build sets EAS_BUILD_GIT_COMMIT_HASH; GitHub Actions (CI's walk-like build) GITHUB_SHA.
  const commit = read(env, "EAS_BUILD_GIT_COMMIT_HASH") ?? read(env, "GITHUB_SHA");
  if (commit !== undefined && GIT_COMMIT.test(commit)) infoPlist["USGGitCommit"] = commit;
  const easBuildId = read(env, "EAS_BUILD_ID");
  if (easBuildId !== undefined && UUID.test(easBuildId)) infoPlist["USGEasBuildId"] = easBuildId;
  if (buildProfile === "walk") infoPlist["NSLocationWhenInUseUsageDescription"] = LOCATION_USAGE;

  return {
    profile: buildProfile,
    infoPlist,
    podfileProperties: { [RECORDER_PODFILE_PROPERTY]: "true" },
  };
}

/** Writes the settings into an Info.plist's contents, removing the keys they don't set. */
export function applyInfoPlist<T extends Record<string, unknown>>(
  plist: T,
  settings: RecorderSettings | null,
): T {
  const out: Record<string, unknown> = { ...plist };
  for (const key of [...RECORDER_INFO_PLIST_KEYS, ...NEVER_SET_INFO_PLIST_KEYS]) delete out[key];
  Object.assign(out, settings?.infoPlist);
  return out as T;
}

/** Writes the settings into Podfile.properties.json's contents, removing the switch when off. */
export function applyPodfileProperties(
  properties: Record<string, string>,
  settings: RecorderSettings | null,
): Record<string, string> {
  const out = { ...properties };
  delete out[RECORDER_PODFILE_PROPERTY];
  return { ...out, ...settings?.podfileProperties };
}

/** The config plugin; `env` is for the tests, Expo passes nothing and it reads process.env. */
const withUsgRecorder: ConfigPlugin<RecorderEnv | undefined> = (config, env) => {
  const settings = recorderSettings(env ?? process.env);
  const withPlist = withInfoPlist(config, (mod) => {
    mod.modResults = applyInfoPlist(mod.modResults, settings);
    return mod;
  });
  return withPodfileProperties(withPlist, (mod) => {
    mod.modResults = applyPodfileProperties(mod.modResults, settings);
    return mod;
  });
};

export default withUsgRecorder;
