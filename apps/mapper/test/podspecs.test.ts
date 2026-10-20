// Every pod of the capture module takes the recorder switch and its build settings from
// modules/capture-native/usg-recorder.rb (the lean recorder design, section 2), so all of them
// compile the recorder or none does, each with -O. A pod added to expo-module.config.json without
// the pattern fails here, before CI's macOS job.

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { podNames } from "../scripts/encoder-check-lib.mts";

const MODULE = fileURLToPath(new URL("../modules/capture-native/", import.meta.url));
const HELPER = join(MODULE, "usg-recorder.rb");

const config = JSON.parse(readFileSync(join(MODULE, "expo-module.config.json"), "utf8")) as {
  apple: { podspecPath: string[] };
};

test.each(config.apple.podspecPath)("%s requires usg-recorder.rb and uses its settings", (path) => {
  const podspec = join(MODULE, path);
  const source = readFileSync(podspec, "utf8");
  const required = [...source.matchAll(/^require_relative '([^']+)'$/gm)].map((match) =>
    resolve(dirname(podspec), `${match[1]}.rb`),
  );
  expect(required.map((file) => relative(MODULE, file))).toContain(relative(MODULE, HELPER));
  const settings = [...source.matchAll(/pod_target_xcconfig\s*=\s*(.+)$/gm)].map((m) => m[1]);
  expect(settings).toEqual(["usg_xcconfig"]);
});

test("the pods are the module's", () => {
  expect(podNames(config)).toEqual(expect.arrayContaining(["CaptureNative", "CaptureCore"]));
});

test("usg-recorder.rb reads the property the config plugin writes", async () => {
  const { RECORDER_PODFILE_PROPERTY } = await import("../plugins/with-usg-recorder.ts");
  const helper = readFileSync(HELPER, "utf8");
  expect(helper).toContain(`['${RECORDER_PODFILE_PROPERTY}'] == 'true'`);
  expect(helper).toContain("Pod::Config.instance.installation_root");
  for (const setting of [
    "'DEFINES_MODULE' => 'YES'",
    "'SWIFT_OPTIMIZATION_LEVEL' => '-O'",
    "'SWIFT_COMPILATION_MODE' => 'wholemodule'",
    "'$(inherited) USG_RECORDER' : '$(inherited)'",
  ]) {
    expect(helper).toContain(setting);
  }
});
