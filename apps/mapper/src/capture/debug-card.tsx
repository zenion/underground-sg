// The debug card (the lean recorder design, section 13; the backlog's debug screen task): the
// module's figures from the latest status, the boundary trace's counts and the module's log ring,
// as formatted by figures.ts. Counts, rates, sizes and timings only; never a pose or a time of day.

import { useState } from "react";
import type { DebugFigures } from "../../modules/capture-native/src/types.ts";
import { Button, Card, Note, Row } from "../ui.tsx";
import type { BoundaryTraceFigures } from "./boundary-trace.ts";
import {
  type FormattedSection,
  formatDebugFigures,
  formatLogTail,
  formatTraceFigures,
} from "./figures.ts";
import { LOG_CHECK_TEXT, runLogCheck } from "./log-check.ts";

export function SectionRows({ section }: { section: FormattedSection }) {
  return (
    <>
      <Note tone="normal">{section.title}</Note>
      {section.rows.map((row) => (
        <Row key={`${section.title}/${row.label}`} label={row.label} value={row.value} />
      ))}
    </>
  );
}

export function DebugCard({
  figures,
  trace,
  logTail,
}: {
  figures: DebugFigures | null;
  trace: BoundaryTraceFigures | null;
  logTail: (() => readonly string[]) | null;
}) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<{ lines: string[]; notShown: number } | null>(null);
  const [checked, setChecked] = useState<number | null>(null);
  const formatted = formatDebugFigures(figures);

  return (
    <Card title="Debug">
      <Button label={open ? "Hide figures" : "Show figures"} onPress={() => setOpen(!open)} />
      {open ? (
        <>
          {formatted.sections.length === 0 ? (
            <Note>
              No figures yet: the module sends them about once a second while a session runs.
            </Note>
          ) : null}
          {formatted.sections.map((section) => (
            <SectionRows key={section.title} section={section} />
          ))}
          {formatted.notShown > 0 ? (
            <Note tone="warn">{`${formatted.notShown} figures not shown (unknown or not a count)`}</Note>
          ) : null}
          {trace ? <SectionRows section={formatTraceFigures(trace)} /> : null}
          {logTail ? (
            <Button label="Load the log tail" onPress={() => setLog(formatLogTail(logTail()))} />
          ) : null}
          {log ? (
            <>
              {log.lines.length === 0 ? <Note>The log ring is empty.</Note> : null}
              {log.lines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: log lines repeat; their order is the key.
                <Note key={index}>{line}</Note>
              ))}
              {log.notShown > 0 ? (
                <Note tone="warn">{`${log.notShown} log lines not shown`}</Note>
              ) : null}
            </>
          ) : null}
          <Button label="Log check" onPress={() => setChecked(runLogCheck().length)} />
          <Note>
            {checked === null
              ? `Log check: sends "${LOG_CHECK_TEXT}" to the console, React Native's log hook and the error handler, while you watch pymobiledevice3 syslog (docs/phone-testing.md). In the walk build none of it may appear.`
              : `Sent through ${checked} channels. In the walk build the syslog must show none of it, only "[redacted capture error]".`}
          </Note>
        </>
      ) : null}
    </Card>
  );
}
