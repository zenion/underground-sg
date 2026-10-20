// eas.json's build profiles (ADR 0010; the lean recorder design, sections 2 and 10): only the
// development and walk profiles set the recorder switch, each with its own USG_BUILD_PROFILE; the
// walk build is Release, internal distribution and not a dev client, for a device, never the
// simulator; nothing is set up for submitting to TestFlight or the App Store, and there is no
// update channel, so the walk build's JavaScript is always the embedded bundle. The app config
// registers the switch's plugin.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import appConfig from "../app.config.ts";
import { recorderSettings } from "../plugins/with-usg-recorder.ts";

interface BuildProfile {
  readonly extends?: string;
  readonly developmentClient?: boolean;
  readonly distribution?: string;
  readonly channel?: string;
  readonly env?: Record<string, string>;
  readonly ios?: { readonly buildConfiguration?: string; readonly simulator?: boolean };
}

interface EasJson {
  readonly build: Record<string, BuildProfile>;
  readonly submit?: unknown;
}

const eas = JSON.parse(
  readFileSync(fileURLToPath(new URL("../eas.json", import.meta.url)), "utf8"),
) as EasJson;

test("has the development and walk profiles only", () => {
  expect(Object.keys(eas.build).sort()).toEqual(["development", "walk"]);
});

test("only development and walk set the recorder switch, each with its own profile", () => {
  for (const [name, profile] of Object.entries(eas.build)) {
    expect(profile.extends, name).toBeUndefined();
    const switched = profile.env?.["USG_RECORDER"] === "1";
    expect(switched, name).toBe(name === "development" || name === "walk");
    if (switched) {
      expect(profile.env?.["USG_BUILD_PROFILE"], name).toBe(name);
      expect(recorderSettings(profile.env ?? {})?.profile, name).toBe(name);
    }
  }
});

test("the development profile is the dev client, internal distribution", () => {
  expect(eas.build["development"]).toMatchObject({
    developmentClient: true,
    distribution: "internal",
  });
});

test("the walk profile is Release on a device, internal distribution, not a dev client", () => {
  const walk = eas.build["walk"];
  expect(walk).toMatchObject({
    developmentClient: false,
    distribution: "internal",
    ios: { buildConfiguration: "Release", simulator: false },
  });
  // The env is exactly the switch: nothing that could reach a log or a build server's settings.
  expect(walk?.env).toEqual({ USG_RECORDER: "1", USG_BUILD_PROFILE: "walk" });
});

test("nothing submits to TestFlight or the App Store, and no profile has an update channel", () => {
  expect(eas.submit).toBeUndefined();
  for (const [name, profile] of Object.entries(eas.build)) {
    expect(profile.channel, name).toBeUndefined();
    expect(profile.distribution, name).toBe("internal");
  }
});

test("the app config registers the switch's plugin", () => {
  const config = appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
  expect(config.plugins).toContain("./plugins/with-usg-recorder.ts");
});
