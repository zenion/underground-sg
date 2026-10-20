import { Tabs } from "expo-router/js-tabs";
import { type AndroidSymbol, type SFSymbol, SymbolView } from "expo-symbols";
import type { ColorValue } from "react-native";
import { CaptureNative } from "../../modules/capture-native/index.ts";
import { useCaptureActive } from "../capture/active.ts";
import { installLogGuard } from "../capture/log-guard.ts";
import { buildProfileOf } from "../capture/native.ts";
import { colors } from "../ui.tsx";

// The walk build silences JavaScript's console and redacts uncaught errors from launch (ADR 0010,
// the lean recorder design's D19); in every other build this does nothing.
installLogGuard(buildProfileOf(CaptureNative));

// Expo Router's error screen, with a retry, instead of a blank screen when a screen throws.
export { ErrorBoundary } from "expo-router";

/** An SF Symbol on iOS; a Material Symbol on Android and the web. */
function icon(ios: SFSymbol, other: AndroidSymbol) {
  return ({ color, size }: { color: ColorValue; size: number }) => (
    <SymbolView name={{ ios, android: other, web: other }} tintColor={color} size={size} />
  );
}

export default function TabsLayout() {
  // While a walk session runs the tab bar is hidden: leaving the walk screen would unmount the
  // camera, and the Map tab would mount the map next to ARKit.
  const captureActive = useCaptureActive();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        ...(captureActive ? { tabBarStyle: { display: "none" } } : {}),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Map",
          tabBarIcon: icon("map", "map"),
          // The map unmounts when its tab loses focus (index.tsx); a frozen screen would delay that.
          freezeOnBlur: false,
        }}
      />
      <Tabs.Screen
        name="floorplan"
        options={{ title: "Floor plan", tabBarIcon: icon("square.grid.3x3", "grid_on") }}
      />
      <Tabs.Screen
        name="capture"
        options={{ title: "Capture", tabBarIcon: icon("camera.viewfinder", "photo_camera") }}
      />
      <Tabs.Screen
        name="walk"
        options={{ title: "Walk", tabBarIcon: icon("figure.walk", "directions_walk") }}
      />
      <Tabs.Screen
        name="recordings"
        options={{ title: "Recordings", tabBarIcon: icon("tray.full", "inventory_2") }}
      />
      <Tabs.Screen
        name="about"
        options={{ title: "About", tabBarIcon: icon("info.circle", "info") }}
      />
    </Tabs>
  );
}
