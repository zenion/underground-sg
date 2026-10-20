// The encoder check on the capture module's compiled objects (ADR 0010), run by the macOS CI job
// after the unsigned app build. macOS only: it uses Xcode's nm and swift-demangle, and reads the
// Objective-C method names from each object file itself.
//
//   node scripts/encoder-check.mts --derived-data <dir> --module CaptureNative --module CaptureCore
//       Checks every object file of each module's build directory in the app build's DerivedData,
//       against modules/capture-native/encoder-allowlist.json. Fails on any finding, and when a
//       module has no objects (so a moved build directory can't pass by checking nothing).
//   node scripts/encoder-check.mts --self-test <dir>
//       Compiles each Swift file in <dir> for iOS and checks it with an empty allow-list. A file
//       whose first line is `// expect: <rule> | <rule>` must be caught by one of those rules;
//       any other file must pass. Proves the check catches a planted symbol and a planted selector.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type AllowList,
  describeFinding,
  type Finding,
  findViolations,
  machOSections,
  methodNames,
  parseSymbols,
} from "./encoder-check-lib.mts";

const ALLOW_LIST = fileURLToPath(
  new URL("../modules/capture-native/encoder-allowlist.json", import.meta.url),
);
// The module's deployment target is 16.4; 17.0 lets the planted files use newer API too.
const PLANTED_TARGET = "arm64-apple-ios17.0";

function xcrun(args: string[], input?: string): string {
  return execFileSync("xcrun", args, {
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "inherit"],
  });
}

function readObject(file: string, object: string): Finding[] {
  const undefinedSymbols = parseSymbols(xcrun(["nm", "-u", "-j", file]));
  const demangled =
    undefinedSymbols.length > 0
      ? xcrun(["swift-demangle"], `${undefinedSymbols.join("\n")}\n`).split(/\r?\n/)
      : [];
  const selectors = methodNames(readFileSync(file));
  return findViolations({ object, undefinedSymbols, demangled, selectors }, loadAllowList());
}

/** How much the check read from an object, for the self-test's output. */
function counts(file: string): string {
  const symbols = parseSymbols(xcrun(["nm", "-u", "-j", file])).length;
  return `${symbols} undefined symbols, ${methodNames(readFileSync(file)).length} selectors`;
}

/**
 * What a planted object holds, printed when the self-test fails: its sections and its undefined
 * symbols, demangled. Only for the planted files, which hold no data.
 */
function describePlanted(file: string): string {
  const sections = machOSections(readFileSync(file)).map(
    (s) => `  section ${s.segment},${s.section} (${s.bytes.length} bytes)`,
  );
  const symbols = parseSymbols(xcrun(["nm", "-u", "-j", file]));
  const demangled = xcrun(["swift-demangle"], `${symbols.join("
")}
`).split(/?
/);
  return [...sections, ...demangled.filter(Boolean).map((name) => `  symbol ${name}`)].join("
");
}

let allowList: AllowList | undefined;
function loadAllowList(): AllowList {
  if (!allowList) {
    const raw = JSON.parse(readFileSync(ALLOW_LIST, "utf8")) as Record<string, unknown>;
    allowList = Object.fromEntries(
      Object.entries(raw).filter(([key]) => !key.startsWith("$")),
    ) as AllowList;
  }
  return allowList;
}

/** Every `.o` under each directory named `<module>.build`. */
function moduleObjects(root: string, module: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, inModule: boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, inModule || entry.name === `${module}.build`);
      else if (inModule && entry.name.endsWith(".o")) found.push(path);
    }
  };
  walk(root, false);
  return found.sort();
}

function checkBuild(derivedData: string, modules: string[]): number {
  const root = join(derivedData, "Build", "Intermediates.noindex");
  let failures = 0;
  for (const module of modules) {
    const objects = moduleObjects(root, module);
    if (objects.length === 0) {
      console.error(`${module}: no object files under ${module}.build in ${root}`);
      failures++;
      continue;
    }
    const findings = objects.flatMap((file) => readObject(file, `${module}/${basename(file)}`));
    for (const finding of findings) console.error(describeFinding(finding));
    console.log(`${module}: ${objects.length} object files, ${findings.length} findings`);
    failures += findings.length;
  }
  return failures;
}

function selfTest(dir: string): number {
  const out = mkdtempSync(join(tmpdir(), "encoder-check-"));
  let failures = 0;
  for (const name of readdirSync(dir)
    .filter((file) => file.endsWith(".swift"))
    .sort()) {
    const source = join(dir, name);
    const expected = /^\/\/ expect: (.+)$/m.exec(
      readFileSync(source, "utf8").split("\n")[0] ?? "",
    )?.[1];
    const object = join(out, name.replace(/\.swift$/, ".o"));
    xcrun([
      "--sdk",
      "iphoneos",
      "swiftc",
      "-target",
      PLANTED_TARGET,
      "-parse-as-library",
      "-c",
      source,
      "-o",
      object,
    ]);
    const findings = readObject(object, `planted/${basename(object)}`);
    const rules = [...new Set(findings.map((finding) => finding.rule))];
    const ok = expected
      ? expected.split("|").some((rule) => rules.includes(rule.trim()))
      : findings.length === 0;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${name}: expected ${expected ?? "no findings"}, found ${rules.length ? rules.join(", ") : "none"} (${counts(object)})`,
    );
    if (!ok) {
      console.log(describePlanted(object));
      failures++;
    }
  }
  return failures;
}

const { values } = parseArgs({
  options: {
    "derived-data": { type: "string" },
    module: { type: "string", multiple: true },
    "self-test": { type: "string" },
  },
});

let failures: number;
if (values["self-test"]) {
  allowList = {};
  failures = selfTest(values["self-test"]);
} else if (values["derived-data"] && values.module?.length) {
  failures = checkBuild(values["derived-data"], values.module);
} else {
  console.error(
    "usage: encoder-check.mts --derived-data <dir> --module <name>... | --self-test <dir>",
  );
  process.exit(2);
}
process.exit(failures > 0 ? 1 : 0);
