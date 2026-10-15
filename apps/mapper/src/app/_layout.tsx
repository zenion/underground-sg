import { Tabs } from "expo-router/js-tabs";
import { type AndroidSymbol, type SFSymbol, SymbolView } from "expo-symbols";
import type { ColorValue } from "react-native";
import { colors } from "../ui.tsx";

// Expo Router's error screen, with a retry, instead of a blank screen when a screen throws.
export { ErrorBoundary } from "expo-router";

/** An SF Symbol on iOS; a Material Symbol on Android and the web. */
function icon(ios: SFSymbol, other: AndroidSymbol) {
  return ({ color, size }: { color: ColorValue; size: number }) => (
    <SymbolView name={{ ios, android: other, web: other }} tintColor={color} size={size} />
  );
}

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.accent }}>
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
        name="about"
        options={{ title: "About", tabBarIcon: icon("info.circle", "info") }}
      />
    </Tabs>
  );
}
