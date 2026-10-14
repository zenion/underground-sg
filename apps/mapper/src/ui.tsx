// Small shared pieces for the screens: colours, a card, label/value rows and a button.

import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

export const colors = {
  text: "#1b1f23",
  muted: "#59636e",
  border: "#d0d7de",
  background: "#f6f8fa",
  card: "#ffffff",
  accent: "#0b6bcb",
  good: "#1a7f37",
  bad: "#cf222e",
  warn: "#9a6700",
};

export type Tone = "normal" | "good" | "bad" | "warn" | "muted";

const toneColor: Record<Tone, string> = {
  normal: colors.text,
  good: colors.good,
  bad: colors.bad,
  warn: colors.warn,
  muted: colors.muted,
};

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Row({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, { color: toneColor[tone] }]} selectable>
        {value}
      </Text>
    </View>
  );
}

export function Note({ children, tone = "muted" }: { children: ReactNode; tone?: Tone }) {
  return <Text style={[styles.note, { color: toneColor[tone] }]}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  disabled = false,
  selected = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        selected && styles.buttonSelected,
        (pressed || disabled) && { opacity: disabled ? 0.4 : 0.7 },
      ]}
    >
      <Text style={[styles.buttonLabel, selected && styles.buttonLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

export const screenStyles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12 },
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
  },
  cardTitle: { fontSize: 13, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  label: { fontSize: 15, color: colors.muted, flexShrink: 0 },
  value: { fontSize: 15, flexShrink: 1, textAlign: "right", fontVariant: ["tabular-nums"] },
  note: { fontSize: 14, lineHeight: 20 },
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card,
  },
  buttonSelected: { backgroundColor: colors.accent },
  buttonLabel: { fontSize: 16, fontWeight: "600", color: colors.accent, textAlign: "center" },
  buttonLabelSelected: { color: "#ffffff" },
});
