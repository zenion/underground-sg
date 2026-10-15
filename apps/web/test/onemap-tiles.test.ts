// OneMap serves its tiles as `Content-Type: image/undefined` with `X-Content-Type-Options:
// nosniff` (packages/map-style/src/onemap.ts). This runs MapLibre GL JS 6.14's own raster tile
// path (RasterTileSource.loadTile: the image request, the fetch, the decode and the texture
// upload) against responses with those headers, with the browser parts that Node lacks stubbed:
// the decoder (createImageBitmap) reads the PNG's size from its bytes and fails on anything that
// isn't a PNG, as a browser's would, and the texture records what it is given. MapLibre fetches a
// tile as bytes and decodes them itself, so the declared type never reaches the decoder; if an
// upgrade changes that, this test fails. The rendering itself is checked in a browser (README.md).

import { crc32, deflateSync } from "node:zlib";
import { createMapStyle, SOURCES } from "@usg/map-style";
import { type RasterSourceSpecification, RasterTileSource } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/** A valid RGBA PNG of `width` x `height`, every pixel grey. */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const row = Buffer.alloc(1 + width * 4, 0xe3);
  row[0] = 0; // no filter
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels)),
      chunk("IEND", new Uint8Array(0)),
    ]),
  );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** OneMap's headers on a tile (checked against the tile server on 2026-10-15). */
const ONEMAP_HEADERS = {
  "Content-Type": "image/undefined",
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "max-age=14400, s-maxage=14400, must-revalidate",
};

/** The tile at zoom 17 over City Hall MRT. */
const TILE = { z: 17, x: 103346, y: 65065 };

interface Uploaded {
  width: number;
  height: number;
}

let requests: Request[];
let uploads: Uploaded[];
let responseBody: Uint8Array;

beforeEach(() => {
  requests = [];
  uploads = [];
  // What MapLibre's image path reads from a browser's globals.
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("window", { location: { href: "http://localhost:5173/", protocol: "http:" } });
  vi.stubGlobal("HTMLImageElement", class HTMLImageElement {});
  vi.stubGlobal("fetch", async (request: Request) => {
    requests.push(request);
    return new Response(responseBody.slice(), { status: 200, headers: ONEMAP_HEADERS });
  });
  // A decoder that, like a browser's, goes by the bytes: a PNG decodes, anything else fails.
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
      throw new Error("The source image could not be decoded.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    return { width: view.getUint32(16), height: view.getUint32(20), close() {} };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Loads one tile through MapLibre's RasterTileSource built from the style's basemap source. */
async function loadTile() {
  const style = createMapStyle({ glyphs: "/glyphs/{fontstack}/{range}.pbf" });
  const spec = style.sources[SOURCES.basemap] as RasterSourceSpecification;
  const source = new RasterTileSource(
    SOURCES.basemap,
    spec,
    undefined as never,
    undefined as never,
  );
  const map = {
    getPixelRatio: () => 2,
    // Map's default: tiles that expire are refreshed, which is the path that fetches bytes.
    _refreshExpiredTiles: true,
    _requestManager: { transformRequest: (url: string) => ({ url }) },
    painter: {
      context: { gl: { RGBA: 0, LINEAR: 0, CLAMP_TO_EDGE: 0, LINEAR_MIPMAP_NEAREST: 0 } },
      getTileTexture: () => ({
        update: (image: Uploaded) => {
          uploads.push(image);
        },
      }),
    },
  };
  Object.assign(source, { map, tiles: spec.tiles });
  const tile = {
    tileID: {
      canonical: {
        url: (tiles: string[]) =>
          (tiles[0] ?? "")
            .replace("{z}", String(TILE.z))
            .replace("{x}", String(TILE.x))
            .replace("{y}", String(TILE.y)),
      },
    },
    aborted: false,
    state: "loading",
    setExpiryData() {},
  };
  await source.loadTile(tile as never);
  return tile;
}

describe("OneMap raster tiles in MapLibre GL JS", () => {
  test("a tile served as image/undefined with nosniff is decoded and uploaded", async () => {
    responseBody = png(256, 256);
    const tile = await loadTile();
    expect(requests.map((request) => request.url)).toEqual([
      `https://www.onemap.gov.sg/maps/tiles/Grey_HD/${TILE.z}/${TILE.x}/${TILE.y}.png`,
    ]);
    expect(tile.state).toBe("loaded");
    expect(uploads).toEqual([expect.objectContaining({ width: 256, height: 256 })]);
  });

  test("the decoder is what judges the bytes: a page that isn't an image fails the tile", async () => {
    responseBody = new TextEncoder().encode("<html><body>Error</body></html>");
    await expect(loadTile()).rejects.toThrow(/could not be decoded/);
    expect(uploads).toEqual([]);
  });

  test("an empty 200 (OneMap's answer outside its tiles) becomes a transparent tile", async () => {
    responseBody = new Uint8Array(0);
    const tile = await loadTile();
    expect(tile.state).toBe("loaded");
    expect(uploads).toEqual([expect.objectContaining({ width: 1, height: 1 })]);
  });
});
