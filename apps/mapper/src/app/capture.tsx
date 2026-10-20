// Capture: the capture-native Swift module's checks, and a desk check of the camera. In Expo Go the
// module can never load (Expo Go runs only its own native code), so the screen explains what is
// needed and shows what it can about the device.
//
// The camera check starts an ARSession only when Start is tapped, writes nothing, and unmounts the
// view (stopping the session) whenever this tab isn't showing. The module keeps the camera out of
// screenshots and covers it before iOS takes its app-switcher snapshot (ADR 0010).

import * as Device from "expo-device";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  type Capabilities,
  CaptureNative,
  type CaptureStatus,
  CaptureView,
  type CaptureViewHandle,
  type CaptureWarning,
} from "../../modules/capture-native/index.ts";
import { iosDriftWarning, lidarExpectation } from "../capture/device.ts";
import {
  bestVideoFormat,
  captureReady,
  describeRate,
  describeTracking,
  describeVideoFormat,
  describeWarning,
  thermalTone,
} from "../capture/status.ts";
import { useMountedMaps } from "../map/presence.ts";
import { Button, Card, Note, Row, screenStyles } from "../ui.tsx";

const lidarText = {
  expected: "Expected (iPhone 12 Pro or later Pro model)",
  "not expected": "Not expected on this model",
  unknown: "Unknown",
} as const;

const yesNo = (value: boolean): string => (value ? "Yes" : "No");

export default function CaptureScreen() {
  const focused = useIsFocused();
  const mountedMaps = useMountedMaps();
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);

  useEffect(() => {
    if (!CaptureNative) return;
    try {
      setCapabilities(CaptureNative.getCapabilities());
    } catch (error) {
      setCapabilitiesError(`getCapabilities() failed: ${String(error)}`);
    }
  }, []);

  const lidar = lidarExpectation(Device.modelName);
  const driftWarning = iosDriftWarning(Device.osName, Device.osVersion);
  const bestFormat = useMemo(
    () => (capabilities ? bestVideoFormat(capabilities.videoFormats) : null),
    [capabilities],
  );

  return (
    <ScrollView style={screenStyles.scroll} contentContainerStyle={screenStyles.content}>
      <Card title="Capture module">
        <Row
          label="CaptureNative"
          value={CaptureNative ? "Loaded" : "Not in this build"}
          tone={CaptureNative ? "good" : "warn"}
        />
        {capabilities ? (
          <>
            <Row
              label="LiDAR mesh"
              value={yesNo(capabilities.sceneReconstruction)}
              tone={capabilities.sceneReconstruction ? "good" : "bad"}
            />
            <Row
              label="World tracking"
              value={yesNo(capabilities.worldTracking)}
              tone={capabilities.worldTracking ? "good" : "bad"}
            />
            <Row label="Smoothed depth" value={yesNo(capabilities.smoothedSceneDepth)} />
            <Row label="Best video format" value={describeVideoFormat(bestFormat)} />
            <Row label="Hardware" value={capabilities.deviceModel} tone="muted" />
            <Row label="iOS" value={capabilities.osVersion} tone="muted" />
            <Row
              label="Recorder"
              value={capabilities.recorder ? "Compiled in" : "Not in this build"}
              tone="muted"
            />
          </>
        ) : null}
        {capabilitiesError ? <Note tone="bad">{capabilitiesError}</Note> : null}
        {CaptureNative ? null : (
          <Note>
            LiDAR capture runs in the app's own Swift module (ARKit, keyframes and face blur), and
            Expo Go can only run the native code it ships with. Capture needs a development build of
            this app. Until then, the map and the floor-plan benchmark work here in Expo Go.
          </Note>
        )}
      </Card>

      {CaptureView && capabilities && captureReady(capabilities) ? (
        <CameraCheck focused={focused} />
      ) : null}

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
          label="LiDAR (from the name)"
          value={lidarText[lidar]}
          tone={lidar === "expected" ? "good" : lidar === "unknown" ? "muted" : "warn"}
        />
        {driftWarning ? <Note tone="bad">{driftWarning}</Note> : null}
        <Note>
          The LiDAR line here is a guess from the model name. ARKit's own check, from the capture
          module, is the LiDAR mesh line above.
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

/** The camera with the live mesh, Start and Stop, and the module's 5 Hz status. */
function CameraCheck({ focused }: { focused: boolean }) {
  const view = useRef<CaptureViewHandle>(null);
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [warning, setWarning] = useState<CaptureWarning | null>(null);
  const [screenshot, setScreenshot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Leaving the tab unmounts the view, which stops the session: what it reported is over. The
  // screenshot reminder stays until the owner says it's deleted.
  useEffect(() => {
    if (!focused) {
      setStatus(null);
      setWarning(null);
    }
  }, [focused]);

  const run = (action: "start" | "stop") => {
    const handle = view.current;
    if (!handle) return;
    setBusy(true);
    setError(null);
    if (action === "start") setWarning(null);
    handle[action]()
      .catch((reason: unknown) => setError(String(reason)))
      .finally(() => setBusy(false));
  };

  const running = status?.running ?? false;
  const tracking = status ? describeTracking(status) : null;
  const warningText = warning ? describeWarning(warning) : null;
  const NativeView = CaptureView;
  if (!NativeView) return null;

  return (
    <Card title="Camera check">
      {screenshot ? (
        <>
          <Note tone="bad">{describeWarning({ kind: "screenshot" })}</Note>
          <Button label="Done, it's deleted" onPress={() => setScreenshot(false)} />
        </>
      ) : null}
      <View style={styles.camera}>
        {focused ? (
          <NativeView
            ref={view}
            style={StyleSheet.absoluteFill}
            onStatus={(event) => setStatus(event.nativeEvent)}
            onWarning={(event) => {
              const next = event.nativeEvent;
              if (next.kind === "screenshot") setScreenshot(true);
              else setWarning(next);
            }}
          />
        ) : null}
      </View>
      <View style={styles.buttons}>
        <Button label="Start" onPress={() => run("start")} disabled={busy || running} />
        <Button label="Stop" onPress={() => run("stop")} disabled={busy || !running} />
      </View>
      {error ? <Note tone="bad">{error}</Note> : null}
      {warningText ? <Note tone="warn">{warningText}</Note> : null}
      <Row
        label="Session"
        value={running ? "Running" : "Stopped"}
        tone={running ? "good" : "muted"}
      />
      {status ? (
        <>
          <Row
            label="Cover"
            value={status.covered ? "On" : "Off"}
            tone={status.covered ? "warn" : "normal"}
          />
          {tracking ? <Row label="Tracking" value={tracking.text} tone={tracking.tone} /> : null}
          <Row label="World mapping" value={status.mapping} tone="muted" />
          <Row label="Frame rate" value={describeRate(status.fps)} />
          <Row
            label="Candidates"
            value={`${status.candidates} (${describeRate(status.candidateHz)})`}
          />
          <Row label="Mesh anchors" value={String(status.meshAnchors)} />
          <Row label="Thermal" value={status.thermal} tone={thermalTone(status.thermal)} />
        </>
      ) : null}
      <Note>
        A desk check: nothing is written or sent, and the session stops when you leave this tab.
        Screenshots and screen recordings should show the camera area black, and the app switcher
        should show "Camera hidden". Never share a screenshot of this view.
      </Note>
    </Card>
  );
}

const styles = StyleSheet.create({
  camera: {
    height: 360,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: "#000000",
    marginVertical: 8,
  },
  buttons: {
    flexDirection: "row",
    gap: 8,
  },
});
