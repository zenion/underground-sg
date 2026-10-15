import type { ConfigContext, ExpoConfig } from "expo/config";

// The mapper app. Runs in Expo Go today (map, floor-plan benchmark, device checks); LiDAR capture
// needs a development build with the capture-native module (ADR 0007, README.md).
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Underground SG Mapper",
  slug: "underground-sg",
  // The Expo account that owns the EAS project (the owner signs in as a member of it).
  owner: "joshland",
  scheme: "usg-mapper",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  ios: {
    // Placeholder: confirm before the first EAS build. It can't change once the app is registered
    // with Apple.
    bundleIdentifier: "com.zenion.usg.mapper",
    supportsTablet: false,
    infoPlist: {
      // Placeholders for the development build; Expo Go uses its own.
      NSCameraUsageDescription:
        "The camera and LiDAR scanner map the underground walkways. Faces and screens are blurred on the phone before any image is saved.",
      NSLocalNetworkUsageDescription:
        "The app uploads captures to the mapping server on your local network.",
    },
  },
  web: {
    bundler: "metro",
    // A single-page app: static rendering would run the map (a DOM component) in Node.
    output: "single",
  },
  plugins: ["expo-router"],
  extra: {
    ...config.extra,
    // The owner's EAS project (`eas init --id`). Not a secret: it identifies the project for EAS
    // Build and Update, and the slug above must match the project's slug on expo.dev.
    eas: { projectId: "9b77d53f-ffc5-47f7-8291-34d12a32c739" },
  },
});
