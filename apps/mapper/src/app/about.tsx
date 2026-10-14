// About: versions, the JavaScript engine and the API the app will talk to.

import { isRunningInExpoGo } from "expo";
import Constants from "expo-constants";
import { useCallback, useEffect, useState } from "react";
import { Platform, ScrollView } from "react-native";
import { checkHealth, type Health } from "../about/health.ts";
import { jsEngine } from "../about/runtime.ts";
import { apiUrl, devServerHost } from "../config.ts";
import { Button, Card, Note, Row, screenStyles } from "../ui.tsx";

function runningIn(): string {
  if (Platform.OS === "web") return "Web browser";
  if (isRunningInExpoGo()) return "Expo Go";
  return __DEV__ ? "Development build" : "Release build";
}

export default function AboutScreen() {
  const config = Constants.expoConfig;
  const engine = jsEngine();
  const api = apiUrl();
  const [health, setHealth] = useState<Health | "checking" | null>(null);

  const check = useCallback(() => {
    if (api.url === null) return;
    setHealth("checking");
    checkHealth(api.url, (url, init) => fetch(url, init)).then(setHealth);
  }, [api.url]);

  useEffect(check, [check]);

  // Platform.constants is undefined on the web (react-native-web).
  const rn = (
    Platform.constants as { reactNativeVersion?: { major: number; minor: number; patch: number } }
  )?.reactNativeVersion;
  return (
    <ScrollView style={screenStyles.scroll} contentContainerStyle={screenStyles.content}>
      <Card title="App">
        <Row label="Name" value={config?.name ?? "?"} />
        <Row label="Version" value={config?.version ?? "?"} />
        <Row label="Expo SDK" value={config?.sdkVersion ?? "?"} />
        <Row
          label="React Native"
          value={rn ? `${rn.major}.${rn.minor}.${rn.patch}` : "react-native-web"}
        />
        <Row label="Running in" value={runningIn()} />
        <Row
          label="JavaScript engine"
          value={`${engine.name}${engine.version ? ` ${engine.version}` : ""}`}
          tone={engine.name === "Hermes" || Platform.OS === "web" ? "normal" : "warn"}
        />
        <Row label="Bundle" value={__DEV__ ? "Development (Metro)" : "Production"} />
      </Card>

      <Card title="API">
        <Row label="Dev server" value={devServerHost() ?? "None"} tone="muted" />
        {api.url !== null ? (
          <>
            <Row label="Base URL" value={api.url} />
            <Row label="From" value={api.source} tone="muted" />
            <Row
              label="GET /health"
              value={
                health === null || health === "checking"
                  ? "Checking…"
                  : health.ok
                    ? `OK, HTTP ${health.status} in ${health.ms} ms`
                    : "Not reachable"
              }
              tone={
                health === null || health === "checking" ? "muted" : health.ok ? "good" : "warn"
              }
            />
            {health !== null && health !== "checking" && !health.ok ? (
              <Note>
                {health.problem} That's expected until the API exists (services/api); when it runs
                on this PC, check that it listens on all interfaces and that Windows Firewall lets
                the port through.
              </Note>
            ) : null}
            <Button label="Check again" disabled={health === "checking"} onPress={check} />
          </>
        ) : (
          <Note tone="warn">{api.problem}</Note>
        )}
        <Note>
          The app uses the dev server's host with port EXPO_PUBLIC_API_PORT (default 28000), or
          EXPO_PUBLIC_API_URL when set.
        </Note>
      </Card>
    </ScrollView>
  );
}
