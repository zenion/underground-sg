// Recordings: the session recordings on the phone (the lean recorder design, sections 9 and 10):
// ids, sizes, durations and ages in days only; Export (the walk build only) with its progress;
// Delete, after a confirmation; the Apple Devices runbook for copying an export to the PC; what
// recovery did at launch; and the on-device self-test (design D18) with its report.

import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, View } from "react-native";
import type {
  BuildProfile,
  ExportProgress,
  RecordingSummary,
  RecoveryReport,
  SelfTestReport,
} from "../../modules/capture-native/src/types.ts";
import { appCapture } from "../capture/app.ts";
import { SectionRows } from "../capture/debug-card.tsx";
import {
  documentsAsExpected,
  formatBytes,
  formatRecoveryReport,
  formatSelfTestReport,
} from "../capture/figures.ts";
import { type CaptureNative, captureErrorCode, recorderCapabilities } from "../capture/native.ts";
import {
  canDelete,
  canExport,
  describeRecordingState,
  exportPercent,
  exportRunbook,
  recordingRows,
} from "../capture/recordings.ts";
import { Button, Card, Note, Row, screenStyles } from "../ui.tsx";

function failure(action: string, error: unknown): string {
  return `${action} failed (${captureErrorCode(error) ?? "no code"}).`;
}

export default function RecordingsScreen() {
  const [capture] = useState(appCapture);
  if (!capture) {
    return (
      <ScrollView style={screenStyles.scroll} contentContainerStyle={screenStyles.content}>
        <Card title="Recordings">
          <Note>
            Recordings live in the app's own storage on the phone, which only the capture module
            reaches. Expo Go and the web can't load it.
          </Note>
        </Card>
      </ScrollView>
    );
  }
  return <Recordings capture={capture} />;
}

function buildProfile(capture: CaptureNative): BuildProfile | null {
  try {
    return recorderCapabilities(capture.capabilities()).buildProfile;
  } catch {
    return null;
  }
}

function Recordings({ capture }: { capture: CaptureNative }) {
  const focused = useIsFocused();
  const [profile] = useState(() => buildProfile(capture));
  const [recordings, setRecordings] = useState<readonly RecordingSummary[] | null>(null);
  const [recovery, setRecovery] = useState<RecoveryReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [exported, setExported] = useState<{ id: string; parts: number; tarBytes: number } | null>(
    null,
  );
  const [selfTest, setSelfTest] = useState<SelfTestReport | null>(null);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(() => {
    capture.listRecordings().then(setRecordings, (error: unknown) => {
      setProblem(failure("Listing the recordings", error));
    });
    capture.recoveryStatus().then(setRecovery, () => setRecovery(null));
  }, [capture]);

  useEffect(() => {
    if (focused) refresh();
  }, [focused, refresh]);

  useEffect(
    () =>
      capture.onExportProgress((event) => {
        setProgress(event);
      }),
    [capture],
  );

  const exportOne = (id: string) => {
    setProblem(null);
    setExporting(id);
    setProgress(null);
    setExported(null);
    capture
      .exportRecording(id)
      .then(
        (result) => setExported({ id, parts: result.parts, tarBytes: result.tarBytes }),
        (error: unknown) => setProblem(failure("Export", error)),
      )
      .finally(() => {
        setExporting(null);
        refresh();
      });
  };

  const deleteOne = (summary: RecordingSummary) => {
    const lost =
      summary.state === "exported"
        ? "This deletes the recording and its export on the phone. Do it only after the export is copied to the PC and validated."
        : "This recording isn't exported: deleting it loses it for good.";
    Alert.alert("Delete the recording?", lost, [
      { text: "Keep it", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setProblem(null);
          capture
            .deleteRecording(summary.id)
            .catch((error: unknown) => setProblem(failure("Delete", error)))
            .finally(refresh);
        },
      },
    ]);
  };

  const runSelfTest = (keep: boolean) => {
    setProblem(null);
    setTesting(true);
    capture
      .selfTest(keep)
      .then(setSelfTest, (error: unknown) => setProblem(failure("The self-test", error)))
      .finally(() => {
        setTesting(false);
        refresh();
      });
  };

  return (
    <ScrollView style={screenStyles.scroll} contentContainerStyle={screenStyles.content}>
      {problem ? (
        <Card title="Problem">
          <Note tone="bad">{problem}</Note>
          <Button label="OK" onPress={() => setProblem(null)} />
        </Card>
      ) : null}

      <Card title="On this phone">
        <Row label="Build" value={profile ?? "no recorder"} />
        {profile === "walk" ? null : (
          <Note>
            Only the walk build exports. This build can list and delete recordings, but an export
            here is refused.
          </Note>
        )}
        {recordings === null ? <ActivityIndicator /> : null}
        {recordings !== null && recordings.length === 0 ? <Note>No recordings.</Note> : null}
        <Button label="Refresh" onPress={refresh} />
      </Card>

      {(recordings ?? []).map((summary) => {
        const state = describeRecordingState(summary.state);
        const busy = exporting !== null;
        return (
          <Card key={summary.id} title="Recording">
            <Row label="Id" value={summary.id} tone="muted" />
            <Row label="State" value={state.text} tone={state.tone} />
            {recordingRows(summary).map((row) => (
              <Row key={row.label} label={row.label} value={row.value} />
            ))}
            {exporting === summary.id ? (
              <>
                <ActivityIndicator />
                <Row label="Exporting" value={`${exportPercent(progress)} %`} />
                <Note>Keep the app open and the phone unlocked until it finishes.</Note>
              </>
            ) : null}
            {exported?.id === summary.id ? (
              <Note tone="good">
                {`Exported: ${exported.parts} parts, ${formatBytes(exported.tarBytes)}. Copy it to the PC (below).`}
              </Note>
            ) : null}
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {canExport(summary, profile) ? (
                <Button label="Export" disabled={busy} onPress={() => exportOne(summary.id)} />
              ) : null}
              {canDelete(summary) ? (
                <Button
                  label="Delete"
                  disabled={exporting === summary.id}
                  onPress={() => deleteOne(summary)}
                />
              ) : null}
            </View>
          </Card>
        );
      })}

      <Card title="Copy an export to the PC">
        {exportRunbook(exported?.id ?? null).map((step, index) => (
          <Note key={step} tone="normal">{`${index + 1}. ${step}`}</Note>
        ))}
      </Card>

      <Card title="Self-test">
        <Note>
          A 60 s synthetic session through the real recorder and file code: file protection, the
          backup flag, Compression and CryptoKit, and timings. It records no sensor data.
        </Note>
        <Button
          label={testing ? "Running…" : "Run the self-test"}
          disabled={testing}
          onPress={() => runSelfTest(false)}
        />
        {profile === "walk" ? (
          <Button
            label="Run and keep it for export"
            disabled={testing}
            onPress={() => runSelfTest(true)}
          />
        ) : null}
        {selfTest ? (
          <>
            <SectionRows section={formatSelfTestReport(selfTest)} />
            {documentsAsExpected(selfTest.documentsNames) ? null : (
              <Note tone="bad">Documents holds something other than exports: report it.</Note>
            )}
          </>
        ) : null}
      </Card>

      <Card title="Recovery at launch">
        <SectionRows section={formatRecoveryReport(recovery)} />
      </Card>
    </ScrollView>
  );
}
