import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SCHEMA_FILE } from "../../src/config.ts";
import { normalizeDump, SCHEMA_HEADER } from "../../src/dump.ts";

// The shape of pg_dump 18's output, CRLF as it can arrive on Windows.
const RAW = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "",
  "\\restrict Kq8m2XbYzVd0pLr4",
  "",
  "-- Dumped from database version 18.6 (Debian 18.6-1.pgdg13+2)",
  "-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg13+2)",
  "",
  "SET statement_timeout = 0;",
  "",
  "",
  "",
  "CREATE TYPE public.trust_tier AS ENUM (",
  "    'new',",
  "    'owner'",
  ");",
  "",
  "\\unrestrict Kq8m2XbYzVd0pLr4",
  "",
].join("\r\n");

describe("normalizeDump", () => {
  const out = normalizeDump(RAW, ["20261014210350", "20261101090000"]);

  test("starts with the generated-file header", () => {
    expect(out.startsWith(SCHEMA_HEADER)).toBe(true);
  });

  test("drops the lines that change between runs or servers", () => {
    expect(out).not.toMatch(/restrict|Dumped (from|by)/);
  });

  test("keeps the SQL, with LF line endings and no runs of blank lines", () => {
    expect(out).toContain("CREATE TYPE public.trust_tier AS ENUM (\n    'new',\n    'owner'\n);");
    expect(out).not.toContain("\r");
    expect(out).not.toMatch(/\n\n\n/);
    expect(out.endsWith(";\n")).toBe(true);
  });

  test("appends the applied migrations in dbmate's format", () => {
    expect(out).toContain(
      "INSERT INTO public.schema_migrations (version) VALUES\n    ('20261014210350'),\n    ('20261101090000');\n",
    );
  });

  test("is stable", () => {
    expect(
      normalizeDump(RAW.replace("Kq8m2XbYzVd0pLr4", "a1b2c3"), [
        "20261014210350",
        "20261101090000",
      ]),
    ).toBe(out);
  });
});

test("db/schema.sql is a generated dump, not the old hand-written draft", () => {
  const schema = readFileSync(SCHEMA_FILE, "utf8");
  expect(schema.startsWith(SCHEMA_HEADER)).toBe(true);
  expect(schema).toMatch(/^CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;$/m);
  expect(schema).toMatch(/^INSERT INTO public\.schema_migrations \(version\) VALUES$/m);
});
