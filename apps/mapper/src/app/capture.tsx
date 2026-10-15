// Capture: looks for the capture-native Swift module, which doesn't exist yet. In Expo Go it can
// never load (Expo Go runs only its own native code), so for now this screen explains what is
// needed and shows what it can about the device.

import { requireOptionalNativeModule } from "expo";
import * as Device from "expo-device";
import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { iosDriftWarning, lidarExpectation } from "../capture/device.ts";
import { useMountedMaps } from "../map/presence.ts";
import { Card, Note, Row, screenStyles } from "../ui.tsx";

interface CaptureNativeModule {
  getCapabilities?: () => unknown;
}

// The name the module will register (apps/mapper/modules/capture-native, ADR 0007).
const captureNative = requireOptionalNativeModule<CaptureNativeModule>("CaptureNative");

const lidarText = {
  expected: "Expected (iPhone 12 Pro or later Pro model)",
  "not expected": "Not expected on this model",
  unknown: "Unknown: the module's getCapabilities() will tell",
} as const;

export default function CaptureScreen() {
  const mountedMaps = useMountedMaps();
  const [capabilities, setCapabilities] = useState<string | null>(null);

  useEffect(() => {
    if (!captureNative?.getCapabilities) return;
    Promise.resolve(captureNative.getCapabilities())
      .then((value) => setCapabilities(JSON.stringify(value, null, 1)))
      .catch((error: unknown) => setCapabilities(`getCapabilities() failed: ${String(error)}`));
  }, []);

  const lidar = lidarExpectation(Device.modelName);
  const driftWarning = iosDriftWarning(Device.osName, Device.osVersion);

  return (
    <ScrollView style={screenStyles.scroll} contentContainerStyle={screenStyles.content}>
      <Card title="Capture module">
        <Row
          label="CaptureNative"
          value={captureNative ? "Loaded" : "Not in this build"}
          tone={captureNative ? "good" : "warn"}
        />
        {captureNative ? (
          <Note>{capabilities ?? "No getCapabilities() yet."}</Note>
        ) : (
          <Note>
            LiDAR capture runs in the app's own Swift module (ARKit, keyframes and face blur), and
            Expo Go can only run the native code it ships with. Capture needs a development build of
            this app, and installing one on an iPhone needs the Apple Developer Program (US$99 a
            year). Until then, the map and the floor-plan benchmark work here in Expo Go.
          </Note>
        )}
      </Card>

      <Card title="This device">
        <Row label="Model" value={Device.modelName ?? "Unknown"} />
        <Row label="Model ID" value={Device.modelId ?? "Unknown"} tone="muted" />
        <Row label="System" value={`${Device.osName ?? "?"} ${Device.osVersion ?? ""}`.trim()} />
        <Row
          label="Physical device"
          value={Device.isDevice ? "Yes" : "No (simulator)"}
          tone={Device.isDevice ? "normal" : "warn"}
        />
        <Row
          label="LiDAR"
          value={lidarText[lidar]}
          tone={lidar === "expected" ? "good" : lidar === "unknown" ? "muted" : "warn"}
        />
        {driftWarning ? <Note tone="bad">{driftWarning}</Note> : null}
        <Note>
          The LiDAR line is a guess from the model name. The real check is ARKit's support for scene
          reconstruction, which the capture module will report.
        </Note>
      </Card>

      <Card title="Map">
        <Row
          label="Map while capturing"
          value={mountedMaps === 0 ? "Unmounted" : `${mountedMaps} mounted`}
          tone={mountedMaps === 0 ? "good" : "bad"}
        />
        <Note>
          The map's WebView competes with ARKit for the GPU, memory and heat, so it is unmounted
          whenever the Map tab isn't showing.
        </Note>
      </Card>
    </ScrollView>
  );
}
