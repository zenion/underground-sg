// Map: the published underground map over OneMap's street map (@usg/map-style), with a level
// switcher, and polygon and point drawing on top (maplibre-gl and terra-draw in a DOM component).
// The DOM component loads the published map from the API this screen names. The drawn features
// live in this screen's state. The map itself is mounted only while this tab is focused, so it is
// gone on the Capture screen (ADR 0007); when it comes back it restores the features from here.

import { useIsFocused } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiUrl } from "../config.ts";
import DrawMap from "../map/draw-map.tsx";
import {
  countFeatures,
  type DrawnFeature,
  describeCounts,
  toDrawnFeatures,
} from "../map/features.ts";
import { useCountMountedMap } from "../map/presence.ts";
import { colors } from "../ui.tsx";

export default function MapScreen() {
  const focused = useIsFocused();
  const [features, setFeatures] = useState<DrawnFeature[]>([]);
  // A native action: the DOM component calls it across the bridge, so it must be async.
  const onFeaturesChange = useCallback(async (next: DrawnFeature[]) => {
    setFeatures(toDrawnFeatures(next));
  }, []);

  return (
    <View style={styles.screen}>
      <View style={styles.summary}>
        <Text style={styles.summaryText}>{describeCounts(countFeatures(features))} drawn</Text>
      </View>
      {focused ? (
        <MountedMap initialFeatures={features} onFeaturesChange={onFeaturesChange} />
      ) : (
        <View style={styles.placeholder} />
      )}
    </View>
  );
}

function MountedMap({
  initialFeatures,
  onFeaturesChange,
}: {
  initialFeatures: DrawnFeature[];
  onFeaturesChange: (features: DrawnFeature[]) => Promise<void>;
}) {
  useCountMountedMap();
  // The features as they were when the map mounted: the map takes them once, and passing the
  // live list would send every change back across the bridge.
  const [initial] = useState(initialFeatures);
  // EXPO_PUBLIC_API_URL (pnpm dev:phone sets it to the tunnel), or derived from the dev server.
  const [api] = useState(apiUrl);
  return (
    <View style={styles.map}>
      <DrawMap
        initialFeatures={initial}
        onFeaturesChange={onFeaturesChange}
        apiUrl={api.url}
        {...(api.url === null ? { apiProblem: api.problem } : {})}
        dom={{ style: styles.webView, scrollEnabled: false, bounces: false }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  summary: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  summaryText: { fontSize: 16, fontWeight: "600", color: colors.text },
  map: { flex: 1 },
  webView: { flex: 1 },
  placeholder: { flex: 1 },
});
