import { describe, expect, test } from "vitest";
import { apiBaseUrl, DEFAULT_API_PORT, hostOf } from "../src/about/api-url.ts";

describe("apiBaseUrl", () => {
  test("takes the dev server's host and the default API port", () => {
    expect(DEFAULT_API_PORT).toBe(28000);
    expect(apiBaseUrl({ hostUri: "192.168.1.20:8081" })).toEqual({
      url: "http://192.168.1.20:28000",
      source: "dev server",
    });
    expect(apiBaseUrl({ hostUri: "josh-pc.local:8081", port: "" })).toEqual({
      url: "http://josh-pc.local:28000",
      source: "dev server",
    });
  });

  test("uses EXPO_PUBLIC_API_PORT", () => {
    expect(apiBaseUrl({ hostUri: "10.0.0.5:8081", port: "3000" })).toEqual({
      url: "http://10.0.0.5:3000",
      source: "dev server",
    });
    for (const port of ["0", "65536", "80a", "-1", "1.5"]) {
      const result = apiBaseUrl({ hostUri: "10.0.0.5:8081", port });
      expect(result.url, port).toBeNull();
      expect(result).toHaveProperty("problem", expect.stringContaining("EXPO_PUBLIC_API_PORT"));
    }
  });

  test("EXPO_PUBLIC_API_URL overrides the derived URL", () => {
    expect(
      apiBaseUrl({ explicitUrl: " https://api.example.test/ ", hostUri: "10.0.0.5:8081" }),
    ).toEqual({ url: "https://api.example.test", source: "EXPO_PUBLIC_API_URL" });
    expect(apiBaseUrl({ explicitUrl: "http://192.168.1.20:28000/v1//" })).toEqual({
      url: "http://192.168.1.20:28000/v1",
      source: "EXPO_PUBLIC_API_URL",
    });
    // Blank counts as unset.
    expect(apiBaseUrl({ explicitUrl: "  ", hostUri: "10.0.0.5:8081" })).toMatchObject({
      url: "http://10.0.0.5:28000",
    });
  });

  test("rejects an EXPO_PUBLIC_API_URL that isn't an http(s) URL", () => {
    expect(apiBaseUrl({ explicitUrl: "192.168.1.20:28000" }).url).toBeNull();
    expect(apiBaseUrl({ explicitUrl: "not a url" }).url).toBeNull();
    expect(apiBaseUrl({ explicitUrl: "ftp://host/" })).toEqual({
      url: null,
      problem: 'EXPO_PUBLIC_API_URL must be http or https: "ftp://host/".',
    });
  });

  test("asks for EXPO_PUBLIC_API_URL without a dev server or through a tunnel", () => {
    for (const hostUri of [undefined, null, "", "  "]) {
      expect(apiBaseUrl({ hostUri })).toEqual({
        url: null,
        problem: "No dev-server host to derive it from. Set EXPO_PUBLIC_API_URL.",
      });
    }
    for (const hostUri of ["abc-anonymous-8081.exp.direct", "x1y2.ngrok-free.app:443"]) {
      expect(apiBaseUrl({ hostUri }).url, hostUri).toBeNull();
    }
    expect(
      apiBaseUrl({
        hostUri: "abc-anonymous-8081.exp.direct",
        explicitUrl: "http://10.0.0.5:28000",
      }),
    ).toMatchObject({ url: "http://10.0.0.5:28000" });
  });

  test("keeps IPv6 hosts in brackets", () => {
    expect(apiBaseUrl({ hostUri: "[fe80::1c2a:3b4c]:8081" })).toMatchObject({
      url: "http://[fe80::1c2a:3b4c]:28000",
    });
  });
});

describe("hostOf", () => {
  test("strips the port, a scheme and a path", () => {
    expect(hostOf("192.168.1.20:8081")).toBe("192.168.1.20");
    expect(hostOf("localhost")).toBe("localhost");
    expect(hostOf("exp://192.168.1.20:8081/--/path")).toBe("192.168.1.20");
    expect(hostOf("[::1]:8081")).toBe("[::1]");
    expect(hostOf("[::1")).toBeNull();
    expect(hostOf(":8081")).toBeNull();
  });
});
