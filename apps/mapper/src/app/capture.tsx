// Capture: the capture-native Swift module's checks, and a desk check of the camera. In Expo Go the
// module can never load (Expo Go runs only its own native code), so the screen explains what is
// needed and shows what it can about the device.
//
// The camera check runs on a CaptureSession (the lean recorder design, 3.3 and 3.4) through the
// CaptureNative port, with `record: off`: it starts the ARSession only when Start is tapped, writes
// nothing, and releases the session (stopping it) whenever this tab isn't showing. A build from
// before the native glue has no CaptureSession class; there the check falls back to the view's own
// start and stop. The module keeps the camera out of screenshots and covers it before iOS takes
// its app-switcher snapshot (ADR 0010). Outside the walk build the refusal checks call what the
// development build must refuse (design section 11), for the B2 checklist in docs/phone-testing.md.

import * as Device from "expo-device";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  type Capabilities,
  type CaptureStatus,
  CaptureView,
  type CaptureViewHandle,
  type CaptureWarning,
  CaptureNative as captureModule,
} from "../../modules/capture-native/index.ts";
import { appCapture } from "../capture/app.ts";
import { DebugCard } from "../capture/debug-card.tsx";
import { iosDriftWarning, lidarExpectation } from "../capture/device.ts";
import {
  type CaptureNative,
  type CaptureSessionPort,
  captureErrorCode,
  recorderCapabilities,
  recordRefusalOf,
  type SessionStatus,
  type SessionWarning,
} from "../capture/native.ts";
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
import { CORRIDOR_VENUES } from "../walk/venues.ts";

const lidarText = {
  expected: "Expected (iPhone 12 Pro or later Pro model)",
  "not expected": "Not expected on this model",
  unknown: "Unknown",
} as const;

const yesNo = (value: boolean): string => (value ? "Yes" : "No");

export default function CaptureScreen() {
  const focused = useIsFocused();
  const mountedMaps = useMountedMaps();
  const [capture] = useState(appCapture);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);

  useEffect(() => {
    if (!captureModule) return;
    try {
      setCapabilities(captureModule.getCapabilities());
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
  const recorder = capabilities ? recorderCapabilities(capabilities) : null;
  const ready =
    CaptureView !== null && capture !== null && capabilities && captureReady(capabilities);

  return (
    <ScrollView style={screenStyles.scroll} contentContainerStyle={screenStyles.content}>
      <Card title="Capture module">
        <Row
          label="CaptureNative"
          value={captureModule ? "Loaded" : "Not in this build"}
          tone={captureModule ? "good" : "warn"}
        />
        {capabilities && recorder ? (
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
              value={recorder.compiled ? "Compiled in" : "Not in this build"}
              tone="muted"
            />
            <Row label="Build profile" value={recorder.buildProfile ?? "none"} tone="muted" />
            <Row
              label="Can record"
              value={recorder.canRecord ? "Yes" : `No (${recorder.refusal ?? "no reason given"})`}
              tone={recorder.canRecord ? "good" : "muted"}
            />
          </>
        ) : null}
        {capabilitiesError ? <Note tone="bad">{capabilitiesError}</Note> : null}
        {captureModule ? null : (
          <Note>
            LiDAR capture runs in the app's own Swift module (ARKit, keyframes and face blur), and
            Expo Go can only run the native code it ships with. Capture needs a development build of
            this app. Until then, the map and the floor-plan benchmark work here in Expo Go.
          </Note>
        )}
      </Card>

      {ready && capture ? (
        <CameraCheck
          focused={focused}
          capture={capture}
          leanCheck={recorder !== null && recorder.buildProfile !== "walk"}
        />
      ) : null}

      {capture && recorder && recorder.buildProfile !== "walk" ? (
        <RefusalChecks focused={focused} capture={capture} />
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

/**
 * The session for this tab while it shows: opened on focus, released (which stops it) on blur.
 * `undefined` until the first focus, null in a build without the CaptureSession class.
 */
function useFocusedSession(
  focused: boolean,
  capture: CaptureNative,
): CaptureSessionPort | null | undefined {
  const [session, setSession] = useState<CaptureSessionPort | null | undefined>(undefined);
  useEffect(() => {
    if (!focused) return;
    const opened = capture.openSession();
    setSession(opened);
    return () => {
      opened?.release();
      setSession(undefined);
    };
  }, [focused, capture]);
  return session;
}

function CameraCheck({
  focused,
  capture,
  leanCheck,
}: {
  focused: boolean;
  capture: CaptureNative;
  leanCheck: boolean;
}) {
  const session = useFocusedSession(focused, capture);
  if (session === null) return <LegacyCameraCheck focused={focused} />;
  return <SessionCameraCheck session={session ?? null} capture={capture} leanCheck={leanCheck} />;
}

/** The camera with the live mesh on a CaptureSession, `record: off`, and its 5 Hz status. */
function SessionCameraCheck({
  session,
  capture,
  leanCheck,
}: {
  session: CaptureSessionPort | null;
  capture: CaptureNative;
  /** Outside the walk build: a Lean start that must be refused, with its refusal code. */
  leanCheck: boolean;
}) {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [warning, setWarning] = useState<SessionWarning | null>(null);
  const [screenshot, setScreenshot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMesh, setShowMesh] = useState(true);
  const [leanResult, setLeanResult] = useState<CheckResult | null>(null);

  // A new session (or none) starts with nothing reported. The screenshot reminder stays until
  // the owner says it's deleted.
  useEffect(() => {
    setStatus(null);
    setWarning(null);
    if (!session) return;
    const offs = [
      session.on("status", setStatus),
      session.on("warning", (next) => {
        if (next.kind === "screenshot") setScreenshot(true);
        else setWarning(next);
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [session]);

  const start = () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    setWarning(null);
    session
      .start({ record: "off", venues: [] })
      .catch((reason: unknown) =>
        setError(`Start failed (${captureErrorCode(reason) ?? "no code"}).`),
      )
      .finally(() => setBusy(false));
  };

  const stop = () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    session
      .stop()
      .catch((reason: unknown) =>
        setError(`Stop failed (${captureErrorCode(reason) ?? "no code"}).`),
      )
      .finally(() => setBusy(false));
  };

  // Must be refused: ERR_RECORD_REFUSED with the build's refusal code (design section 11).
  const tryLean = () => {
    if (!session) return;
    setBusy(true);
    setLeanResult(null);
    const first = CORRIDOR_VENUES[0]?.id ?? "";
    session
      .start({ record: "lean", venues: [first] })
      .then(
        async () => {
          setLeanResult({ label: "Lean start", text: "ACCEPTED: report it", ok: false });
          await session.discard().catch(() => undefined);
        },
        (reason: unknown) => {
          const code = captureErrorCode(reason);
          const refusal = recordRefusalOf(reason);
          setLeanResult({
            label: "Lean start",
            text: refusal ? `${code ?? "no code"} (${refusal})` : (code ?? "no code"),
            ok: code === "ERR_RECORD_REFUSED" || code === "ERR_RECORDER_NOT_COMPILED",
          });
        },
      )
      .finally(() => setBusy(false));
  };

  const running = status?.running ?? false;
  const tracking = status ? describeTracking(status) : null;
  const warningText = warning ? describeWarning(warning) : null;
  const NativeView = CaptureView;
  if (!NativeView) return null;

  return (
    <>
      <Card title="Camera check">
        {screenshot ? (
          <>
            <Note tone="bad">{describeWarning({ kind: "screenshot" })}</Note>
            <Button label="Done, it's deleted" onPress={() => setScreenshot(false)} />
          </>
        ) : null}
        <View style={styles.camera}>
          {session ? (
            <NativeView
              style={StyleSheet.absoluteFill}
              session={session.native}
              showMesh={showMesh}
            />
          ) : null}
        </View>
        <View style={styles.buttons}>
          <Button label="Start" onPress={start} disabled={busy || running || !session} />
          <Button label="Stop" onPress={stop} disabled={busy || !running} />
          <Button
            label={showMesh ? "Mesh: on" : "Mesh: off"}
            selected={showMesh}
            onPress={() => setShowMesh(!showMesh)}
          />
        </View>
        {leanCheck ? (
          <Button
            label="Try Lean (must be refused)"
            onPress={tryLean}
            disabled={busy || running || !session}
          />
        ) : null}
        {leanResult ? (
          <Row
            label={leanResult.label}
            value={leanResult.text}
            tone={leanResult.ok ? "good" : "bad"}
          />
        ) : null}
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
            <Row label="Candidates" value={describeRate(status.candidateHz)} />
            <Row label="Mesh anchors" value={String(status.meshAnchors)} />
            <Row label="Thermal" value={status.thermal} tone={thermalTone(status.thermal)} />
            <Row label="Recorder" value={status.recorder.state} tone="muted" />
          </>
        ) : null}
        <Note>
          A desk check with record off: nothing is written or sent, and the session stops when you
          leave this tab. Screenshots and screen recordings should show the camera area black, and
          the app switcher should show "Camera hidden". Never share a screenshot of this view.
        </Note>
      </Card>
      <DebugCard
        figures={status?.debug ?? null}
        trace={session ? session.traceFigures() : null}
        logTail={capture.logTail}
      />
    </>
  );
}

/** Builds before the native glue: the view starts and stops its own ARSession. */
function LegacyCameraCheck({ focused }: { focused: boolean }) {
  const view = useRef<CaptureViewHandle>(null);
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [warning, setWarning] = useState<CaptureWarning | null>(null);
  const [screenshot, setScreenshot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <Card title="Camera check (before the session glue)">
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
        This build predates the CaptureSession glue, so the view runs the camera itself. A desk
        check: nothing is written or sent, and the session stops when you leave this tab.
      </Note>
    </Card>
  );
}

/** A well-formed id no recording has, for the export refusal check. */
const NO_SUCH_RECORDING = "00000000-0000-4000-8000-000000000000";

type CheckResult = { readonly label: string; readonly text: string; readonly ok: boolean };

/**
 * What a build other than the walk build must refuse (design section 11): a lean start (with its
 * refusal code), an export and the location permission. Each check shows the code it got.
 */
function RefusalChecks({ focused, capture }: { focused: boolean; capture: CaptureNative }) {
  const [results, setResults] = useState<readonly CheckResult[]>([]);
  const [busy, setBusy] = useState(false);
  const add = (result: CheckResult) => setResults((previous) => [...previous, result]);

  const tryExport = async () => {
    try {
      await capture.exportRecording(NO_SUCH_RECORDING);
      add({ label: "Export", text: "ACCEPTED: report it.", ok: false });
    } catch (error) {
      const code = captureErrorCode(error);
      add({
        label: "Export",
        text: code ?? "no code",
        ok: code === "ERR_EXPORT_REFUSED" || code === "ERR_RECORDER_NOT_COMPILED",
      });
    }
  };

  const tryLocation = async () => {
    try {
      await capture.requestPermissions();
      add({ label: "Location", text: "Answered, not refused: report it", ok: false });
    } catch (error) {
      add({ label: "Location", text: captureErrorCode(error) ?? "no code", ok: true });
    }
  };

  const run = (check: () => Promise<void>) => {
    setBusy(true);
    check().finally(() => setBusy(false));
  };

  if (!focused) return null;
  return (
    <Card title="Refusal checks">
      <Note>
        This isn't the walk build, so it must refuse to record, to export and to ask for location.
        Each button tries one and shows the code it got; the camera check above has the Lean start.
      </Note>
      <View style={styles.buttons}>
        <Button label="Try an export" disabled={busy} onPress={() => run(tryExport)} />
        <Button label="Try location" disabled={busy} onPress={() => run(tryLocation)} />
      </View>
      {results.map((result, index) => (
        <Row
          // biome-ignore lint/suspicious/noArrayIndexKey: results are appended and never reordered.
          key={index}
          label={result.label}
          value={result.text}
          tone={result.ok ? "good" : "bad"}
        />
      ))}
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
    flexWrap: "wrap",
  },
});
