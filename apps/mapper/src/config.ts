// App configuration from the environment and Expo. The only module that reads process.env:
// Expo inlines EXPO_PUBLIC_ variables only where they are written out in full, as here.

import Constants from "expo-constants";
import { Platform } from "react-native";
import { type ApiUrl, apiBaseUrl } from "./about/api-url.ts";

/** The dev server's host:port: from Expo's manifest, or the page's host in a browser. */
export function devServerHost(): string | null {
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) return hostUri;
  if (Platform.OS === "web") return globalThis.location?.host ?? null;
  return null;
}

export function apiUrl(): ApiUrl {
  return apiBaseUrl({
    explicitUrl: process.env.EXPO_PUBLIC_API_URL,
    port: process.env.EXPO_PUBLIC_API_PORT,
    hostUri: devServerHost(),
  });
}
