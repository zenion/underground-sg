// What the Capture screen can say about the device before the capture module exists. The real
// test is ARKit's own check (scene reconstruction with classification), which only the Swift
// module's getCapabilities() can run, in a development build.

export type LidarExpectation = "expected" | "not expected" | "unknown";

/**
 * Whether the model should have LiDAR, from its marketing name: every iPhone Pro and Pro Max from
 * the iPhone 12 on. An iPad Pro is "unknown" (only those from 2020 on have it, and the name
 * doesn't always say the year), and so is a name expo-device doesn't recognise, such as a model
 * newer than the library.
 */
export function lidarExpectation(modelName: string | null | undefined): LidarExpectation {
  const name = modelName?.trim();
  if (!name) return "unknown";
  const iphone = /^iPhone (\d+) Pro(?: Max)?$/.exec(name);
  if (iphone) return Number(iphone[1]) >= 12 ? "expected" : "not expected";
  if (/^iPad Pro\b/.test(name)) return "unknown";
  if (/^(?:iPhone|iPad|iPod)\b/.test(name)) return "not expected";
  return "unknown";
}

/**
 * CLAUDE.md: avoid iOS 26.4 to 26.6.0, which had a reported LiDAR world-tracking drift regression.
 * Returns a warning for those versions, else null.
 */
export function iosDriftWarning(
  osName: string | null | undefined,
  osVersion: string | null | undefined,
): string | null {
  if (!osName || !/^(?:iOS|iPadOS)$/.test(osName) || !osVersion) return null;
  const [major = 0, minor = 0, patch = 0] = osVersion.split(".").map((part) => Number(part));
  if (major !== 26) return null;
  const inRange = minor === 4 || minor === 5 || (minor === 6 && patch === 0);
  return inRange
    ? `iOS ${osVersion} had a reported LiDAR drift regression (26.4 to 26.6.0). Update iOS before capturing.`
    : null;
}
