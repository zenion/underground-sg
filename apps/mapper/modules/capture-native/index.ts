// The capture-native module (ADR 0007): a local Expo module in Swift (ios/, and the SwiftPM
// targets in Sources/). It exists only in development and walk builds of this app; in Expo Go and
// on the web both exports are null, and the Capture screen says why. The app reaches the session
// recorder through src/capture/native.ts (moduleCaptureNative), never through CaptureNative directly.

import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType, Ref } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import type {
  CaptureNativeModule,
  CaptureSession,
  CaptureStatus,
  CaptureViewHandle,
  CaptureWarning,
} from "./src/types.ts";

export type * from "./src/types.ts";

export interface CaptureViewProps extends ViewProps {
  onStatus?: (event: NativeSyntheticEvent<CaptureStatus>) => void;
  onWarning?: (event: NativeSyntheticEvent<CaptureWarning>) => void;
  /** The CaptureSession that runs in this view (design 3.3); builds before the glue ignore it. */
  session?: CaptureSession | null;
  /**
   * Draws the live mesh over the camera (design Q15; default on). Display only: it changes no
   * ARKit configuration and nothing that is recorded. Builds without the prop ignore it.
   */
  showMesh?: boolean;
  ref?: Ref<CaptureViewHandle>;
}

export const CaptureNative = requireOptionalNativeModule<CaptureNativeModule>("CaptureNative");

/** `<CaptureView>`: the camera and the live mesh, behind the privacy cover. */
export const CaptureView: ComponentType<CaptureViewProps> | null = CaptureNative
  ? requireNativeView<CaptureViewProps>("CaptureNative")
  : null;
