// The app's one CaptureNative port (src/capture/native.ts) over the capture module, shared by the
// walk, Recordings and Capture screens. Null in Expo Go and on the web, where the module can't
// load. The boundary trace sends its pending lines whenever the app's state changes.

import { AppState } from "react-native";
import { CaptureNative as captureModule } from "../../modules/capture-native/index.ts";
import { type CaptureNative, moduleCaptureNative } from "./native.ts";

let port: CaptureNative | null | undefined;

function onAppStateChange(listener: () => void): () => void {
  const subscription = AppState.addEventListener("change", () => listener());
  return () => subscription.remove();
}

export function appCapture(): CaptureNative | null {
  if (port === undefined) port = moduleCaptureNative(captureModule, { onAppStateChange });
  return port;
}
