/// <reference types="expo/types" />

// Expo's process.env typings, plus the EXPO_PUBLIC_ variables this app reads (src/config.ts).
// Expo inlines them into the bundle at build time; set them in apps/mapper/.env.local (git-ignored)
// or the shell that runs `expo start`.
declare namespace __MetroModuleApi {
  interface ProcessEnv {
    /** The API's base URL, such as http://192.168.1.20:28000. Overrides the derived one. */
    readonly EXPO_PUBLIC_API_URL?: string;
    /** The API's port on the dev-server host. Default 28000. */
    readonly EXPO_PUBLIC_API_PORT?: string;
  }
}
