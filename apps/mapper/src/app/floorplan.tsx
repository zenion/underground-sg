// Floor plan: times @usg/floorplan on a synthetic corridor mesh generated on the device, and draws
// the result. This is the Hermes measurement for spike criterion 4 (ADR 0007): the backlog's
// threshold is about 2 s on a recorded mesh.

import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { jsEngine } from "../about/runtime.ts";
import {
  type BenchmarkRun,
  type CorridorSize,
  formatMs,
  medianMs,
  runBenchmark,
  STAGES,
} from "../floorplan/benchmark.ts";
import { svgScene } from "../floorplan/svg.ts";
import { Button, Card, colors, Note, Row, screenStyles } from "../ui.tsx";

// Triangle counts. Dense is the realistic layout as 5 cm squares, as a voxel-based mesh might be:
// the time grows with the triangle count, and ARKit's floor density isn't known yet.
const SIZES: { readonly size: CorridorSize; readonly label: string }[] = [
  { size: "small", label: "Small 25k" },
  { size: "realistic", label: "Realistic 106k" },
  { size: "dense", label: "Dense 1.1M" },
];

export default function FloorplanScreen() {
  const [size, setSize] = useState<CorridorSize>("realistic");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<BenchmarkRun | null>(null);
  const [totals, setTotals] = useState<Record<CorridorSize, number[]>>({
    small: [],
    realistic: [],
    dense: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [showGaps, setShowGaps] = useState(true);

  const start = useCallback((chosen: CorridorSize) => {
    setRunning(true);
    setError(null);
    // Let "Running…" render first: the benchmark blocks the JS thread while it runs.
    setTimeout(() => {
      try {
        const result = runBenchmark(chosen);
        setRun(result);
        setTotals((previous) => ({
          ...previous,
          [chosen]: [...previous[chosen], result.stats.timingsMs.total],
        }));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setRunning(false);
      }
    }, 50);
  }, []);

  // One run on first open, so the number is there without a tap.
  useEffect(() => start("realistic"), [start]);

  const choose = (next: CorridorSize): void => {
    setSize(next);
    start(next);
  };

  const engine = jsEngine();
  const history = totals[size];
  const median = medianMs(history);
  const shown = run?.size === size ? run : null;
  const scene = shown ? svgScene(shown.polygons, showGaps ? shown.gaps : []) : null;

  return (
    <ScrollView style={screenStyles.scroll} contentContainerStyle={screenStyles.content}>
      <View style={styles.buttons}>
        {SIZES.map((entry) => (
          <View key={entry.size} style={styles.flex}>
            <Button
              label={entry.label}
              selected={size === entry.size}
              disabled={running}
              onPress={() => choose(entry.size)}
            />
          </View>
        ))}
      </View>

      <Card>
        <Text style={styles.caption}>Floor plan total</Text>
        <Text style={styles.total}>
          {running ? "Running…" : shown ? `${formatMs(shown.stats.timingsMs.total)} ms` : "–"}
        </Text>
        <Text style={styles.caption}>
          {median === null
            ? "No runs yet"
            : `Median ${formatMs(median)} ms over ${history.length} run${history.length === 1 ? "" : "s"}: ${history.map(formatMs).join(", ")}`}
        </Text>
        <Button label="Run again" disabled={running} onPress={() => start(size)} />
      </Card>

      {error ? (
        <Card title="Error">
          <Note tone="bad">{error}</Note>
        </Card>
      ) : null}

      {shown ? (
        <>
          <Card title="Stages (ms)">
            {STAGES.map((stage) => (
              <Row key={stage} label={stage} value={formatMs(shown.stats.timingsMs[stage])} />
            ))}
            <Row label="gap outlines (overlay)" value={formatMs(shown.gapsMs)} tone="muted" />
            <Row
              label="mesh generation (not timed above)"
              value={formatMs(shown.meshMs)}
              tone="muted"
            />
          </Card>

          <Card title="Result">
            <Row
              label="Triangles"
              value={`${shown.stats.triangles.toLocaleString()} (${shown.stats.skippedTriangles} skipped)`}
            />
            <Row
              label="Grid"
              value={`${shown.stats.gridWidth} × ${shown.stats.gridHeight} cells of 0.1 m`}
            />
            <Row
              label="Polygons"
              value={`${shown.stats.polygons}, ${shown.stats.holes} holes, ${shown.stats.vertices} vertices`}
            />
            <Row label="Islands removed" value={String(shown.stats.removedIslands)} />
            <Row label="Area" value={`${(shown.polygons[0]?.areaM2 ?? 0).toFixed(1)} m²`} />
            <Row
              label="JavaScript engine"
              value={`${engine.name}${engine.version ? ` ${engine.version}` : ""}${__DEV__ ? ", dev bundle" : ""}`}
              tone={engine.name === "Hermes" ? "normal" : "warn"}
            />
          </Card>

          {scene ? (
            <Card title="Plan (as seen from above, session axes)">
              <Svg
                width="100%"
                style={{ aspectRatio: Math.max(0.5, Math.min(2, scene.aspect)) }}
                viewBox={scene.viewBox}
                preserveAspectRatio="xMidYMid meet"
              >
                {scene.outlines.map((d, index) => (
                  <Path
                    // biome-ignore lint/suspicious/noArrayIndexKey: polygons have no ids; the list is rebuilt whole on each run.
                    key={`outline-${index}`}
                    d={d}
                    fill="#0b6bcb33"
                    fillRule="evenodd"
                    stroke={colors.accent}
                    strokeWidth={0.25}
                  />
                ))}
                {scene.gaps.map((d, index) => (
                  <Path
                    // biome-ignore lint/suspicious/noArrayIndexKey: as above.
                    key={`gap-${index}`}
                    d={d}
                    fill="#e3743399"
                    fillRule="evenodd"
                  />
                ))}
              </Svg>
              <Button
                label={showGaps ? "Hide never-observed cells" : "Show never-observed cells"}
                onPress={() => setShowGaps((value) => !value)}
              />
              <Note>
                Blue: the walkable outline. Orange: cells the scan never observed (pillars, the
                unscanned patch, gaps the close bridged). The mesh is synthetic, generated on the
                phone; recorded meshes come with the capture module.
              </Note>
            </Card>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
  caption: { fontSize: 14, color: colors.muted },
  total: {
    fontSize: 48,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
});
