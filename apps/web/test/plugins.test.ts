// The dev server's plugins: the glyph files at /glyphs/ (and in the build), fixture mode's
// /public/, and where pnpm web proxies to the API.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FONT_STACK, GLYPH_RANGES } from "@usg/map-style";
import { describe, expect, test } from "vitest";
import { demoPublicFiles } from "../fixtures/demo-snapshot.ts";
import { apiTarget, DEFAULT_API_PORT } from "../plugins/api.ts";
import { fixtureResponse, fixtureScenario } from "../plugins/fixtures.ts";
import {
  glyphFiles,
  glyphRequestFile,
  glyphsDirectory,
  glyphsMiddleware,
} from "../plugins/glyphs.ts";

/** Runs a connect middleware on a GET and collects the response. */
function get(middleware: ReturnType<typeof glyphsMiddleware>, url: string) {
  const response = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
  const res = {
    set statusCode(value: number) {
      response.status = value;
    },
    setHeader(name: string, value: string) {
      response.headers[name.toLowerCase()] = value;
    },
    end(body?: unknown) {
      response.body = body;
    },
  };
  let nextCalled = false;
  middleware({ method: "GET", url } as never, res as never, () => {
    nextCalled = true;
  });
  return { ...response, nextCalled };
}

describe("the glyphs", () => {
  const directory = glyphsDirectory();

  test("the package's directory has a PBF for every range the style names", () => {
    expect(glyphFiles(directory)).toEqual(
      GLYPH_RANGES.map((range) => `${FONT_STACK}/${range}.pbf`).sort(),
    );
  });

  test.each([
    ["/Noto%20Sans%20Regular/0-255.pbf", "Noto Sans Regular/0-255.pbf"],
    ["/Noto%20Sans%20Regular/8192-8447.pbf?v=1", "Noto Sans Regular/8192-8447.pbf"],
    ["/OFL.txt", "OFL.txt"],
    ["/..%2F..%2Fpackage.json", undefined],
    ["/../package.json/0-255.pbf", undefined],
    ["/Noto%20Sans%20Regular/..%2F..%2Fpackage.json", undefined],
    ["/Noto%20Sans%20Regular/0-255.pbf/extra", undefined],
    ["/Noto%20Sans%20Regular/README.md", undefined],
    ["/%E0%A4%A", undefined],
    ["/", undefined],
  ])("a request for %s serves %s", (url, file) => {
    expect(glyphRequestFile(url)).toBe(file);
  });

  test("the middleware sends the package's bytes, and 404 for anything else", () => {
    const middleware = glyphsMiddleware(directory);
    const found = get(middleware, "/Noto%20Sans%20Regular/0-255.pbf");
    expect(found.status).toBe(200);
    expect(found.headers["content-type"]).toBe("application/x-protobuf");
    expect(
      Buffer.compare(found.body as Buffer, readFileSync(join(directory, FONT_STACK, "0-255.pbf"))),
    ).toBe(0);
    expect(get(middleware, "/Noto%20Sans%20Regular/7680-7935.pbf").status).toBe(404);
    expect(get(middleware, "/..%2Fpackage.json").status).toBe(404);
  });
});

describe("fixture mode", () => {
  const files = demoPublicFiles(new Date());

  test("WEB_FIXTURE picks a scenario; demo is the default", () => {
    expect(fixtureScenario(undefined)).toBe("demo");
    expect(fixtureScenario(" empty ")).toBe("empty");
    expect(() => fixtureScenario("broken")).toThrow(/WEB_FIXTURE is broken/);
  });

  test("each scenario's answer for latest.json", () => {
    expect(fixtureResponse("demo", files, "latest.json")).toMatchObject({ status: 200 });
    expect(fixtureResponse("empty", files, "latest.json")).toEqual({ status: 404 });
    expect(fixtureResponse("down", files, "latest.json")).toEqual({ status: 503 });
    expect(fixtureResponse("html", files, "latest.json").file?.contentType).toBe("text/html");
    const outdated = fixtureResponse("outdated", files, "latest.json").file?.body ?? "";
    expect(JSON.parse(outdated)).toMatchObject({ schema_version: 2 });
  });

  test("other paths: the demo's files, or 404", () => {
    expect(fixtureResponse("demo", files, "status.json").status).toBe(200);
    expect(fixtureResponse("demo", files, "private/anything.json")).toEqual({ status: 404 });
  });
});

describe("apiTarget", () => {
  test("the API on 127.0.0.1, on API_PORT or its default", () => {
    expect(apiTarget(undefined, undefined)).toBe(`http://127.0.0.1:${DEFAULT_API_PORT}`);
    expect(apiTarget("", " ")).toBe("http://127.0.0.1:28000");
    expect(apiTarget(undefined, "28010")).toBe("http://127.0.0.1:28010");
  });

  test("VITE_API_URL wins", () => {
    expect(apiTarget("http://192.168.1.23:28000", "28010")).toBe("http://192.168.1.23:28000");
  });

  test.each([
    [undefined, "port", /API_PORT must be a port number/],
    [undefined, "70000", /API_PORT must be a port number/],
    ["localhost:28000", undefined, /VITE_API_URL must be an http\(s\) URL/],
  ])("refuses VITE_API_URL %s with API_PORT %s", (url, port, message) => {
    expect(() => apiTarget(url, port)).toThrow(message);
  });
});
