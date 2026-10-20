// Walk: the corridor walk with the session recorder (the lean recorder design, section 10; ADR
// 0010). The flow is src/walk/flow.ts, wired to the capture module by src/walk/controller.ts:
// venues → record Off or Lean (Lean only when this build may record) → permissions → Start →
// Mark start (street-facing toggle) → node tags → Mark end, or Mark end and end the session here
// after a 5 s hold-still countdown → Saving → a summary of counts and durations.
//
// Only the walk build records; in the development build Lean is disabled with the module's reason
// and the screen runs record-off desk checks. The map stays unmounted (it is mounted only on its
// own tab, and from the Start tap until the summary the tab bar is hidden and tab presses are
// refused). Nothing here shows or logs a pose or a session time: the controller keeps them inside
// the port's Redacted values.

import { useIsFocused, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { CaptureView } from "../../modules/capture-native/index.ts";
import { setCaptureActive } from "../capture/active.ts";
import { appCapture } from "../capture/app.ts";
import { DebugCard } from "../capture/debug-card.tsx";
import { iosDriftWarning } from "../capture/device.ts";
import { formatDuration } from "../capture/figures.ts";
import type { CaptureCapabilities, CaptureNative } from "../capture/native.ts";
import { describeRate, describeTracking, describeWarning, thermalTone } from "../capture/status.ts";
import { useMountedMaps } from "../map/presence.ts";
import { Button, Card, colors, Note, Row, screenStyles } from "../ui.tsx";
import { WalkController, type WalkSnapshot } from "../walk/controller.ts";
import {
  describeEnded,
  describeRefusal,
  describeWalkError,
  recBadge,
  summaryRows,
} from "../walk/describe.ts";
import { HOLD_STILL_S, isWalkActive, type WalkAction, walkSummary } from "../walk/flow.ts";
import { NODE_TAG_ROW } from "../walk/tags.ts";
import { CORRIDOR_VENUES } from "../walk/venues.ts";

/** The steps that show the camera: the session is attached from Ready until it has stopped. */
const CAMERA_STEPS: ReadonlySet<string> = new Set([
  "ready",
  "starting",
  "armed",
  "walking",
  "marking",
  "holding",
  "closing",
  "stopping",
  "saving",
]);

/** The steps in which Stop is offered (the flow's STOPPABLE). */
const STOP_STEPS: ReadonlySet<string> = new Set([
  "armed",
  "walking",
  "marking",
  "holding",
  "closing",
]);

export default function WalkScreen() {
  const [capture] = useState(appCapture);
  const [controller, setController] = useState<WalkController | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!capture) return;
    let made: WalkController;
    try {
      made = new WalkController(capture);
    } catch {
      setProblem("The capture module didn't answer getCapabilities().");
      return;
    }
    setController(made);
    return () => {
      made.dispose();
      setCaptureActive(false);
    };
  }, [capture]);

  if (!capture) {
    return (
      <ScrollView style={screenStyles.scroll} contentContainerStyle={screenStyles.content}>
        <Card title="Walk">
          <Note>
            The walk needs the capture module, which Expo Go and the web can't load. Walks use the
            walk build; the development build runs the same screen as a desk check, without
            recording.
          </Note>
        </Card>
      </ScrollView>
    );
  }
  if (problem) {
    return (
      <ScrollView style={screenStyles.scroll} contentContainerStyle={screenStyles.content}>
        <Card title="Walk">
          <Note tone="bad">{problem}</Note>
        </Card>
      </ScrollView>
    );
  }
  if (!controller) return null;
  return <Walk capture={capture} controller={controller} />;
}

function Walk({ capture, controller }: { capture: CaptureNative; controller: WalkController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { state } = snapshot;
  const dispatch = controller.dispatch;
  const focused = useIsFocused();
  const router = useRouter();
  const mountedMaps = useMountedMaps();
  const [capabilities] = useState<CaptureCapabilities | null>(() => {
    try {
      return capture.capabilities();
    } catch {
      return null;
    }
  });
  const [showMesh, setShowMesh] = useState(true);

  // From the Start tap until the summary: the layout hides the tab bar and refuses tab presses.
  // A layout effect, so the store changes before the next frame is drawn.
  const active = isWalkActive(state);
  useLayoutEffect(() => setCaptureActive(active), [active]);

  // The walk screen should never lose focus while active; if it somehow does, come back to it
  // rather than keep a camera view mounted on a screen nobody sees.
  useEffect(() => {
    if (active && !focused) router.navigate("/walk");
  }, [active, focused, router]);

  const driftWarning = capabilities ? iosDriftWarning("iOS", capabilities.osVersion) : null;
  const NativeView = CaptureView;
  // The camera only on the focused screen, never on a hidden one.
  const showCamera =
    NativeView !== null && snapshot.session !== null && CAMERA_STEPS.has(state.step) && focused;
  const badge = recBadge(state, snapshot.status);

  return (
    <ScrollView style={screenStyles.scroll} contentContainerStyle={screenStyles.content}>
      {driftWarning ? (
        <Card title="iOS version">
          <Note tone="bad">{driftWarning}</Note>
          <Note>The walk can still go ahead; its recordings may drift.</Note>
        </Card>
      ) : null}

      {snapshot.screenshot ? (
        <Card title="Screenshot">
          <Note tone="bad">{describeWarning({ kind: "screenshot" })}</Note>
          <Button label="Done, it's deleted" onPress={controller.acknowledgeScreenshot} />
        </Card>
      ) : null}

      {state.error ? (
        <Card title="Problem">
          <Note tone="bad">{describeWalkError(state.error, snapshot.refusal)}</Note>
          <Button label="OK" onPress={() => dispatch({ type: "dismissError" })} />
        </Card>
      ) : null}

      {showCamera && NativeView ? (
        <View style={styles.camera}>
          <NativeView
            style={StyleSheet.absoluteFill}
            session={snapshot.session?.native ?? null}
            showMesh={showMesh}
          />
          {badge.visible ? (
            <View style={styles.badge} accessibilityRole="text">
              <Text style={styles.badgeText}>{badge.text}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <StepCard snapshot={snapshot} dispatch={dispatch} capabilities={capabilities} />

      {state.step === "summary" ? (
        <Card title="Summary">
          {summaryRows(walkSummary(state)).map((row) => (
            <Row key={row.label} label={row.label} value={row.value} />
          ))}
          <View style={styles.buttons}>
            <Button label="New session" onPress={() => dispatch({ type: "newSession" })} />
            <Button label="Recordings" onPress={() => router.push("/recordings")} />
          </View>
        </Card>
      ) : null}

      {CAMERA_STEPS.has(state.step) ? (
        <SessionCard snapshot={snapshot} showMesh={showMesh} setShowMesh={setShowMesh} />
      ) : null}

      <Card title="Map">
        <Row
          label="Map while walking"
          value={mountedMaps === 0 ? "Unmounted" : `${mountedMaps} mounted`}
          tone={mountedMaps === 0 ? "good" : "bad"}
        />
      </Card>

      <DebugCard
        figures={snapshot.debug}
        trace={snapshot.session ? snapshot.session.traceFigures() : null}
        logTail={capture.logTail}
      />
    </ScrollView>
  );
}

function StepCard({
  snapshot,
  dispatch,
  capabilities,
}: {
  snapshot: WalkSnapshot;
  dispatch: (action: WalkAction) => void;
  capabilities: CaptureCapabilities | null;
}) {
  const { state } = snapshot;
  const recorder = capabilities?.recorder ?? null;

  switch (state.step) {
    case "venues":
      return (
        <Card title="1. Venues">
          <Note>The venues this session covers, on the Esplanade corridor.</Note>
          <View style={styles.chips}>
            {CORRIDOR_VENUES.map((venue) => (
              <Button
                key={venue.id}
                label={venue.name}
                selected={state.venues.includes(venue.id)}
                onPress={() => dispatch({ type: "toggleVenue", id: venue.id })}
              />
            ))}
          </View>
          <Button
            label="Next"
            disabled={state.venues.length === 0}
            onPress={() => dispatch({ type: "confirmVenues" })}
          />
        </Card>
      );
    case "record":
      return (
        <Card title="2. Record">
          <View style={styles.buttons}>
            <Button
              label="Off"
              selected={state.record === "off"}
              onPress={() => dispatch({ type: "chooseRecord", record: "off" })}
            />
            <Button
              label="Lean"
              selected={state.record === "lean"}
              disabled={!state.canRecord}
              onPress={() => dispatch({ type: "chooseRecord", record: "lean" })}
            />
          </View>
          {state.canRecord ? (
            <Note>
              Lean records the session (no images): tracking, motion, the mesh and the marks, from
              the start mark to the end mark.
            </Note>
          ) : (
            <Note tone="warn">
              {recorder?.refusal
                ? `Lean is off in this build. ${describeRefusal(recorder.refusal)}.`
                : "Lean is off in this build."}
            </Note>
          )}
          <View style={styles.buttons}>
            <Button label="Back" onPress={() => dispatch({ type: "back" })} />
            <Button label="Next" onPress={() => dispatch({ type: "confirmRecord" })} />
          </View>
        </Card>
      );
    case "permissions":
      return (
        <Card title="3. Permissions">
          <Note>
            A lean recording uses motion and, at street-facing anchors only, location. iOS asks once
            for each.
          </Note>
          <Button
            label={state.requestingPermissions ? "Asking…" : "Ask for motion and location"}
            disabled={state.requestingPermissions}
            onPress={() => dispatch({ type: "requestPermissions" })}
          />
          <Button label="Back" onPress={() => dispatch({ type: "back" })} />
        </Card>
      );
    case "ready":
    case "starting":
      return (
        <Card title="4. Start">
          <Row label="Venues" value={String(state.venues.length)} />
          <Row label="Record" value={state.record === "lean" ? "Lean" : "Off (desk check)"} />
          {state.permissions ? (
            <>
              <Row label="Motion" value={state.permissions.motion} />
              <Row label="Location" value={state.permissions.location} />
            </>
          ) : null}
          {snapshot.sessionAvailable ? null : (
            <Note tone="warn">
              This build has no CaptureSession yet (it predates the native glue): the walk needs the
              next development or walk build.
            </Note>
          )}
          {snapshot.refusal ? <Note tone="bad">{describeRefusal(snapshot.refusal)}</Note> : null}
          <Button
            label={state.step === "starting" ? "Starting…" : "Start"}
            disabled={state.step === "starting" || !snapshot.sessionAvailable}
            onPress={() => dispatch({ type: "start" })}
          />
          <Button
            label="Back"
            disabled={state.step === "starting"}
            onPress={() => dispatch({ type: "back" })}
          />
        </Card>
      );
    case "armed":
    case "walking":
    case "marking":
    case "holding":
    case "closing":
    case "stopping":
      return <WalkingCard snapshot={snapshot} dispatch={dispatch} />;
    case "saving":
      return (
        <Card title="Saving">
          <ActivityIndicator />
          <Note>Saving the recording. Keep the app open until the summary shows.</Note>
        </Card>
      );
    case "summary":
      return null;
  }
}

function WalkingCard({
  snapshot,
  dispatch,
}: {
  snapshot: WalkSnapshot;
  dispatch: (action: WalkAction) => void;
}) {
  const { state } = snapshot;
  const busy = state.mark !== null || state.tagging !== null;
  const recording = state.record === "lean";

  const stop = () => {
    const unsaved = recording && state.recording.phase === "open" && state.endMarks === 0;
    if (!unsaved) {
      dispatch({ type: "stop" });
      return;
    }
    Alert.alert(
      "Stop without an end mark?",
      "The recording has no end mark, so stopping now deletes it.",
      [
        { text: "Keep walking", style: "cancel" },
        {
          text: "Stop and delete",
          style: "destructive",
          onPress: () => dispatch({ type: "stop" }),
        },
      ],
    );
  };

  const streetFacing = (
    <Button
      label={state.streetFacing ? "Street-facing: on" : "Street-facing: off"}
      selected={state.streetFacing}
      disabled={state.step === "marking"}
      onPress={() => dispatch({ type: "setStreetFacing", streetFacing: !state.streetFacing })}
    />
  );

  return (
    <Card title={state.step === "armed" ? "5. Mark start" : "6. Walk"}>
      {state.step === "armed" ? (
        <>
          <Note>
            Stand at the start door's threshold, aim at the floor, and mark. The recording opens
            here. Turn street-facing on if the door faces the street (GNSS is kept around it).
          </Note>
          {streetFacing}
          <Button
            label="Mark start"
            disabled={busy}
            onPress={() => dispatch({ type: "markStart" })}
          />
        </>
      ) : null}

      {state.step === "walking" ? (
        <>
          <Note>Tag each node as you pass it. At the end door, mark the end.</Note>
          <View style={styles.chips}>
            {NODE_TAG_ROW.map((button) => (
              <Button
                key={button.kind}
                label={state.tagging === button.kind ? "…" : button.label}
                disabled={busy}
                onPress={() => dispatch({ type: "addTag", kind: button.kind })}
              />
            ))}
          </View>
          {streetFacing}
          <Button label="Mark end" disabled={busy} onPress={() => dispatch({ type: "markEnd" })} />
          <Button
            label="Mark end and end the session here"
            disabled={busy}
            onPress={() => dispatch({ type: "holdStill" })}
          />
        </>
      ) : null}

      {state.step === "marking" ? (
        <Note>{state.mark?.endSessionHere ? "Marking the end…" : "Marking…"}</Note>
      ) : null}

      {state.step === "holding" ? (
        <>
          <Text style={styles.countdown}>
            {`Hold still: ${state.holdRemainingS ?? HOLD_STILL_S} s`}
          </Text>
          <Note>Keep the phone still and aimed at the floor at the door; it marks at 0.</Note>
          <Button label="Cancel" onPress={() => dispatch({ type: "cancelHold" })} />
        </>
      ) : null}

      {state.step === "closing" ? (
        <Note>
          End marked. The recording closes a few seconds later and the session stops by itself. Stay
          where you are.
        </Note>
      ) : null}

      {state.step === "stopping" ? <Note>Stopping…</Note> : null}

      <Row label="Start marks" value={String(state.startMarks)} />
      <Row label="End marks" value={String(state.endMarks)} />
      <Row label="Tags" value={String(Object.values(state.tags).reduce((a, b) => a + b, 0))} />
      {state.recording.phase === "closed" ? (
        <Row label="Recording ended" value={describeEnded(state.recording.ended)} />
      ) : null}
      {/* While closing, Stop ends the recording at once, at the end mark it already has. */}
      {STOP_STEPS.has(state.step) ? <Button label="Stop" onPress={stop} /> : null}
    </Card>
  );
}

function SessionCard({
  snapshot,
  showMesh,
  setShowMesh,
}: {
  snapshot: WalkSnapshot;
  showMesh: boolean;
  setShowMesh: (on: boolean) => void;
}) {
  const { state, status, warning } = snapshot;
  const tracking = status ? describeTracking(status) : null;
  const warningText = warning ? describeWarning(warning) : null;
  return (
    <Card title="Session">
      <Button
        label={showMesh ? "Live mesh: on" : "Live mesh: off"}
        selected={showMesh}
        onPress={() => setShowMesh(!showMesh)}
      />
      <Note>The live mesh is only drawn on screen; turning it off changes nothing recorded.</Note>
      <Row
        label="Session"
        value={state.sessionRunning ? formatDuration(state.sessionS) : "Stopped"}
      />
      <Row label="Recording window" value={formatDuration(state.recordingS)} />
      {warningText ? <Note tone="warn">{warningText}</Note> : null}
      {status ? (
        <>
          {tracking ? <Row label="Tracking" value={tracking.text} tone={tracking.tone} /> : null}
          <Row label="World mapping" value={status.mapping} tone="muted" />
          <Row label="Frame rate" value={describeRate(status.fps)} />
          <Row label="Mesh anchors" value={String(status.meshAnchors)} />
          <Row label="Thermal" value={status.thermal} tone={thermalTone(status.thermal)} />
          <Row label="Recorder" value={status.recorder.state} />
          {status.recorder.degradation ? (
            <Row label="Degradation" value={status.recorder.degradation} tone="warn" />
          ) : null}
          <Row
            label="Cover"
            value={status.covered ? "On" : "Off"}
            tone={status.covered ? "warn" : "normal"}
          />
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  camera: {
    height: 420,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: "#000000",
  },
  // Top right: the module's own native REC badge is in the top-left corner (CaptureView.swift).
  badge: {
    position: "absolute",
    top: 10,
    right: 10,
    backgroundColor: colors.bad,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: "#ffffff", fontWeight: "700", fontVariant: ["tabular-nums"] },
  buttons: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  countdown: { fontSize: 28, fontWeight: "700", color: colors.text, textAlign: "center" },
});
