// The capture-native module (ADR 0007): a local Expo module in Swift (ios/, and the SwiftPM
// targets in Sources/). It exists only in development and walk builds of this app; in Expo Go and
// on the web both exports are null, and the Capture screen says why. The app reaches the session
// and the recorder through src/capture/native.ts (moduleCaptureNative), never through CaptureNative
// directly.

import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType } from "react";
import type { ViewProps } from "react-native";
import type { CaptureNativeModule, CaptureSession } from "./src/types.ts";

export type * from "./src/types.ts";

export interface CaptureViewProps extends ViewProps {
  /**
   * The CaptureSession this view renders (design 3.3 and D4): the session runs the view's ARView
   * and stops when the prop changes or the view unmounts. Builds before the glue ignore it.
   */
  session?: CaptureSession | null;
}

export const CaptureNative = requireOptionalNativeModule<CaptureNativeModule>("CaptureNative");

/** `<CaptureView>`: the camera and the live mesh, behind the privacy cover. */
export const CaptureView: ComponentType<CaptureViewProps> | null = CaptureNative
  ? requireNativeView<CaptureViewProps>("CaptureNative")
  : null;
