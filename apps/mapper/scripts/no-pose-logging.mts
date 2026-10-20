// The no-pose-logging check (ADR 0005 and ADR 0010, "Privacy"): the app's JavaScript never puts a
// pose, transform, GNSS fix, session time or boundary value where it could reach a log, the device
// log or a crash report. test/no-pose-logging.test.ts runs it over the app and on planted cases.
//
// The rule, on the parsed source (Babel's parser, TypeScript and JSX):
// - Sinks: the arguments of any `console.*` call (`globalThis.console.*` too); the arguments of a
//   call or `new` of anything named Error or …Error; the value assigned to a `.message` or
//   `.stack`; the value of a `throw`; and the `${…}` parts of a template literal.
// - A sink may not mention a sensitive identifier: one whose camelCase or snake_case words include
//   transform, pose, camera, hit, position, lat, lon, lng, latitude, longitude, fix, gnss, facing,
//   raw (the adapter's name for the module's unwrapped results) or t (a session time), plural forms
//   included; any name declared with a Redacted or SessionTime type, or with one of the module's
//   raw Native… types imported from modules/capture-native/src/types.ts, anywhere in the scanned
//   files (variables, parameters, properties); and `unwrap`, which is how a Redacted value is read.
//   Identifiers count wherever they appear in the sink (member accesses, call arguments, spreads),
//   except in type positions and as a plain object key; a string key (`result["hit"]`) counts by
//   its words.
// - `console` is only called or assigned to, never read into another name (`const log =
//   console.log`), since the alias would be a sink the check can't see.
// - The app's source never imports a `node:` module (it runs in Hermes; tests and scripts may).
// The words are a deliberately wide net: a name that only sounds like one of them is renamed.
// The check works on names, not on inferred types: a value copied into a neutral name is left to
// review, and to the walk build's log guard.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";

export type PoseRule = "console" | "console-alias" | "error" | "throw" | "template" | "node-import";

export interface PoseFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: PoseRule;
  /** The identifier (or module) that made it a finding: a name from the code, never a value. */
  readonly name: string;
}

export interface SourceFile {
  /** The path relative to the app, with `/`. */
  readonly file: string;
  readonly source: string;
}

export const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  "transform",
  "transforms",
  "pose",
  "poses",
  "camera",
  "cameras",
  "hit",
  "hits",
  "position",
  "positions",
  "lat",
  "lon",
  "lng",
  "latitude",
  "longitude",
  "fix",
  "fixes",
  "gnss",
  "facing",
  "raw",
  "t",
]);

const REDACTED_TYPES: ReadonlySet<string> = new Set(["Redacted", "SessionTime"]);

/** The capture module's types, where the raw Native… results and events are declared. */
const MODULE_TYPES = /(?:^|\/)capture-native\/src\/types(?:\.ts)?$/;
const NATIVE_TYPE = /^Native[A-Z]/;

/** Objects whose `console` is the console. */
const GLOBALS: ReadonlySet<string> = new Set(["globalThis", "global", "window", "self"]);

/**
 * Rules a file may break by design, with the reason. The boundary trace builds its lines from the
 * values it records (that is its job), and they go only to the module's appendBoundary.
 */
export const EXEMPT: Readonly<Record<string, readonly PoseRule[]>> = {
  "src/capture/boundary-trace.ts": ["template"],
};

/** Keys that hold positions, comments or types rather than code that runs. */
const SKIPPED_KEYS: ReadonlySet<string> = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "comments",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "returnType",
  "superTypeParameters",
]);

interface Node {
  readonly type: string;
  readonly loc?: { readonly start: { readonly line: number } };
  readonly [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function children(node: Node, skipTypes: boolean): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "extra" || key.endsWith("Comments") || key === "comments")
      continue;
    if (skipTypes && SKIPPED_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

function walk(node: Node, visit: (node: Node) => void, skipTypes: boolean): void {
  visit(node);
  for (const child of children(node, skipTypes)) walk(child, visit, skipTypes);
}

/** Function types: their parameters are labels, and a callback isn't the value it is passed. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set(["TSFunctionType", "TSConstructorType"]);

/** As walk, types included, but not into a function type. */
function walkDeclared(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of children(node, false)) {
    if (!FUNCTION_TYPES.has(child.type)) walkDeclared(child, visit);
  }
}

function parseSource(file: SourceFile): Node {
  const plugins: ("typescript" | "jsx")[] = file.file.endsWith(".tsx")
    ? ["typescript", "jsx"]
    : ["typescript"];
  return parse(file.source, { sourceType: "module", plugins }) as unknown as Node;
}

/** The words of an identifier: `cameraTransform` → camera, transform; `start_t` → start, t. */
export function identifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

function mentionsSensitiveType(annotation: unknown, types: ReadonlySet<string>): boolean {
  if (!isNode(annotation)) return false;
  let found = false;
  walkDeclared(annotation, (node) => {
    const typeName = node["typeName"];
    if (node.type === "TSTypeReference" && isNode(typeName) && typeName.type === "Identifier") {
      if (types.has(typeName["name"] as string)) found = true;
    }
  });
  return found;
}

/**
 * The type names that make a name sensitive in one file: Redacted and SessionTime, and the raw
 * Native… types, by their local names where the file imports them from the module's types (or
 * declares them, in that file itself). A Native… type from anywhere else (React Native's
 * NativeSyntheticEvent) doesn't count.
 */
function sensitiveTypes(file: string, ast: Node): Set<string> {
  const types = new Set(REDACTED_TYPES);
  const declaresHere = MODULE_TYPES.test(file);
  walk(
    ast,
    (node) => {
      const source = node["source"];
      if (node.type === "ImportDeclaration" && isNode(source)) {
        if (!MODULE_TYPES.test(String(source["value"]))) return;
        for (const specifier of (node["specifiers"] as Node[] | undefined) ?? []) {
          const imported = keyName(specifier["imported"]);
          const local = keyName(specifier["local"]);
          if (
            specifier.type === "ImportSpecifier" &&
            imported &&
            local &&
            NATIVE_TYPE.test(imported)
          )
            types.add(local);
        }
      }
      const id = node["id"];
      if (
        declaresHere &&
        (node.type === "TSInterfaceDeclaration" || node.type === "TSTypeAliasDeclaration") &&
        isNode(id) &&
        NATIVE_TYPE.test(id["name"] as string)
      ) {
        types.add(id["name"] as string);
      }
    },
    true,
  );
  return types;
}

function keyName(key: unknown): string | null {
  if (!isNode(key)) return null;
  if (key.type === "Identifier") return key["name"] as string;
  if (key.type === "StringLiteral") return key["value"] as string;
  return null;
}

/** Names declared with a sensitive type: variables, parameters and properties. */
function redactedNames(ast: Node, types: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();
  walkDeclared(ast, (node) => {
    if (!mentionsSensitiveType(node["typeAnnotation"], types)) return;
    const name =
      node.type === "Identifier"
        ? (node["name"] as string)
        : node.type === "TSPropertySignature" ||
            node.type === "ClassProperty" ||
            node.type === "ClassPrivateProperty"
          ? keyName(node["key"])
          : null;
    if (name !== null) names.add(name);
  });
  return names;
}

function isErrorName(name: unknown): boolean {
  return typeof name === "string" && /^(?:[A-Z][A-Za-z0-9]*)?Error$/.test(name);
}

interface Sink {
  readonly rule: PoseRule;
  readonly line: number;
  readonly parts: readonly Node[];
}

const isMember = (node: Node): boolean =>
  node.type === "MemberExpression" || node.type === "OptionalMemberExpression";
const isCall = (node: Node): boolean =>
  node.type === "CallExpression" || node.type === "OptionalCallExpression";

/** The property name of a member access: `a.b` and `a["b"]` give b; any other computed key, null. */
function memberName(member: Node): string | null {
  const property = member["property"];
  if (!isNode(property)) return null;
  if (member["computed"] !== true) return keyName(property);
  return property.type === "StringLiteral" ? (property["value"] as string) : null;
}

/** `console`, or `globalThis.console` (and global, window, self). */
function isConsole(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (node.type === "Identifier") return node["name"] === "console";
  if (!isMember(node) || memberName(node) !== "console") return false;
  const object = node["object"];
  return isNode(object) && object.type === "Identifier" && GLOBALS.has(object["name"] as string);
}

/** Where a node sits: its parent and the parent's key that holds it. */
interface Place {
  readonly parent: Node | null;
  readonly key: string;
}

function walkPlaces(node: Node, visit: (node: Node, place: Place, up: Place) => void): void {
  const go = (current: Node, place: Place, up: Place): void => {
    visit(current, place, up);
    for (const [key, value] of Object.entries(current)) {
      if (SKIPPED_KEYS.has(key) || key.endsWith("Comments")) continue;
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) if (isNode(item)) go(item, { parent: current, key }, place);
    }
  };
  go(node, { parent: null, key: "" }, { parent: null, key: "" });
}

/**
 * A read of the console that isn't a call or an assignment: `const log = console.log`, `const {
 * log } = console`, `f(console)`. Returns the name read, or null for an allowed use.
 */
function consoleAlias(node: Node, place: Place, up: Place): string | null {
  const { parent, key } = place;
  // The `console` of `globalThis.console`, or a plain key (`{ console: … }`, an interface's
  // `console?: object`), is a name, not a read.
  if (node.type === "Identifier" && parent && parent["computed"] !== true) {
    if (isMember(parent) && key === "property") return null;
    if (key === "key" && parent["shorthand"] !== true) return null;
  }
  if (!isConsole(node)) return null;
  if (!parent || !isMember(parent) || key !== "object") return "console";
  const called = up.parent && isCall(up.parent) && up.key === "callee";
  const assigned = up.parent?.type === "AssignmentExpression" && up.key === "left";
  return called || assigned ? null : `console.${memberName(parent) ?? "[]"}`;
}

function sinks(ast: Node): Sink[] {
  const found: Sink[] = [];
  walk(
    ast,
    (node) => {
      const line = node.loc?.start.line ?? 0;
      const args = (node["arguments"] as Node[] | undefined) ?? [];
      const callee = node["callee"];
      if (isCall(node) && isNode(callee) && isMember(callee) && isConsole(callee["object"])) {
        found.push({ rule: "console", line, parts: args });
      }
      if (
        (isCall(node) || node.type === "NewExpression") &&
        isNode(callee) &&
        callee.type === "Identifier" &&
        isErrorName(callee["name"])
      ) {
        found.push({ rule: "error", line, parts: args });
      }
      // `e.message = …` and `e.stack = …` reach a log or a crash report like `new Error(…)` does.
      const left = node["left"];
      if (node.type === "AssignmentExpression" && isNode(left) && isMember(left)) {
        const name = memberName(left);
        if ((name === "message" || name === "stack") && isNode(node["right"])) {
          found.push({ rule: "error", line, parts: [node["right"]] });
        }
      }
      if (node.type === "ThrowStatement" && isNode(node["argument"])) {
        found.push({ rule: "throw", line, parts: [node["argument"]] });
      }
      if (node.type === "TemplateLiteral") {
        found.push({ rule: "template", line, parts: (node["expressions"] as Node[]) ?? [] });
      }
    },
    true,
  );
  return found;
}

function consoleAliases(ast: Node): { line: number; name: string }[] {
  const found: { line: number; name: string }[] = [];
  walkPlaces(ast, (node, place, up) => {
    const name = consoleAlias(node, place, up);
    if (name !== null) found.push({ line: node.loc?.start.line ?? 0, name });
  });
  return found;
}

function nodeImports(ast: Node): { line: number; name: string }[] {
  const found: { line: number; name: string }[] = [];
  walk(
    ast,
    (node) => {
      const line = node.loc?.start.line ?? 0;
      const source = node["source"];
      if (
        (node.type === "ImportDeclaration" ||
          node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration") &&
        isNode(source) &&
        String(source["value"]).startsWith("node:")
      ) {
        found.push({ line, name: String(source["value"]) });
      }
      const callee = node["callee"];
      const first = (node["arguments"] as Node[] | undefined)?.[0];
      if (
        node.type === "CallExpression" &&
        isNode(callee) &&
        (callee.type === "Import" ||
          (callee.type === "Identifier" && callee["name"] === "require")) &&
        isNode(first) &&
        first.type === "StringLiteral" &&
        String(first["value"]).startsWith("node:")
      ) {
        found.push({ line, name: String(first["value"]) });
      }
    },
    true,
  );
  return found;
}

/** The sensitive identifiers a sink's part mentions, in order. */
function sensitiveIn(part: Node, redacted: ReadonlySet<string>): string[] {
  const names: string[] = [];
  const isSensitive = (name: string): boolean =>
    name === "unwrap" ||
    redacted.has(name) ||
    identifierWords(name).some((word) => SENSITIVE_WORDS.has(word));
  const visit = (node: Node, isKey: boolean): void => {
    if (node.type === "Identifier" && !isKey) {
      const name = node["name"] as string;
      if (isSensitive(name)) names.push(name);
    }
    // `result["hit"]` reads the same value as `result.hit`.
    const property = node["property"];
    if (
      isMember(node) &&
      node["computed"] === true &&
      isNode(property) &&
      property.type === "StringLiteral" &&
      isSensitive(property["value"] as string)
    ) {
      names.push(property["value"] as string);
    }
    for (const child of children(node, true)) {
      // A plain object key (`{ position: n }`) is a label, not a value; a computed or shorthand
      // one is the value itself.
      const plainKey =
        (node.type === "ObjectProperty" || node.type === "ObjectMethod") &&
        child === node["key"] &&
        node["computed"] !== true &&
        node["shorthand"] !== true;
      visit(child, plainKey);
    }
  };
  visit(part, false);
  return names;
}

/** Runs the rule over a set of files; the Redacted names are collected across all of them. */
export function scanSources(
  files: readonly SourceFile[],
  exempt: Readonly<Record<string, readonly PoseRule[]>> = EXEMPT,
): PoseFinding[] {
  const parsed = files.map((file) => ({ file, ast: parseSource(file) }));
  const redacted = new Set<string>();
  for (const { file, ast } of parsed) {
    for (const name of redactedNames(ast, sensitiveTypes(file.file, ast))) redacted.add(name);
  }

  const findings: PoseFinding[] = [];
  const seen = new Set<string>();
  const add = (finding: PoseFinding): void => {
    if (exempt[finding.file]?.includes(finding.rule)) return;
    const key = `${finding.file}:${finding.line}:${finding.rule}:${finding.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  for (const { file, ast } of parsed) {
    for (const sink of sinks(ast)) {
      for (const part of sink.parts) {
        for (const name of sensitiveIn(part, redacted)) {
          add({ file: file.file, line: sink.line, rule: sink.rule, name });
        }
      }
    }
    for (const alias of consoleAliases(ast)) {
      add({ file: file.file, line: alias.line, rule: "console-alias", name: alias.name });
    }
    for (const imported of nodeImports(ast)) {
      add({ file: file.file, line: imported.line, rule: "node-import", name: imported.name });
    }
  }
  return findings;
}

export function describeFinding(finding: PoseFinding): string {
  return `${finding.file}:${finding.line}: ${finding.rule} mentions ${finding.name}`;
}

function sourceFilesIn(appRoot: string, dir: string, recurse: boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(appRoot, dir), { withFileTypes: true })) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (recurse && entry.name !== "node_modules" && entry.name !== "generated") {
        out.push(...sourceFilesIn(appRoot, path, true));
      }
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The files the rule covers: the app's `src/` (without the git-ignored generated maplibre worker)
 * and the capture module's TypeScript (`index.ts`, `src/`), never node_modules.
 */
export function appSourceFiles(appRoot: string): SourceFile[] {
  const paths = [
    ...sourceFilesIn(appRoot, "src", true),
    ...sourceFilesIn(appRoot, "modules/capture-native", false),
    ...sourceFilesIn(appRoot, "modules/capture-native/src", true),
  ].sort();
  return paths.map((file) => ({
    file: relative(appRoot, join(appRoot, file)).replaceAll("\\", "/"),
    source: readFileSync(join(appRoot, file), "utf8"),
  }));
}
