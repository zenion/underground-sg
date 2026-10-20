// The capture-native module (ADR 0007): a local Expo module in Swift (ios/, and the SwiftPM
// targets in Sources/). It exists only in development and walk builds of this app; in Expo Go and
// on the web both exports are null, and the Capture screen says why.

import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { ComponentType, Ref } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import type {
  Capabilities,
  CaptureStatus,
  CaptureViewHandle,
  CaptureWarning,
} from "./src/types.ts";

export type * from "./src/types.ts";

interface CaptureNativeModule {
  getCapabilities(): Capabilities;
}

export interface CaptureViewProps extends ViewProps {
  onStatus?: (event: NativeSyntheticEvent<CaptureStatus>) => void;
  onWarning?: (event: NativeSyntheticEvent<CaptureWarning>) => void;
  ref?: Ref<CaptureViewHandle>;
}

export const CaptureNative = requireOptionalNativeModule<CaptureNativeModule>("CaptureNative");

/** `<CaptureView>`: the camera and the live mesh, behind the privacy cover. */
export const CaptureView: ComponentType<CaptureViewProps> | null = CaptureNative
  ? requireNativeView<CaptureViewProps>("CaptureNative")
  : null;
