import { describe, expect, test } from "vitest";
import { checkHealth } from "../src/about/health.ts";

const clock = (...times: number[]) => {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)] ?? 0;
};

describe("checkHealth", () => {
  test("reports an answer with its status and time", async () => {
    const seen: string[] = [];
    const result = await checkHealth(
      "http://10.0.0.5:28000",
      async (url) => {
        seen.push(url);
        return { status: 200, ok: true };
      },
      3000,
      clock(1000, 1042),
    );
    expect(seen).toEqual(["http://10.0.0.5:28000/health"]);
    expect(result).toEqual({ ok: true, status: 200, ms: 42 });
  });

  test("reports an error status", async () => {
    const result = await checkHealth("http://h:1", async () => ({ status: 503, ok: false }));
    expect(result).toEqual({ ok: false, status: 503, problem: "Answered HTTP 503." });
  });

  test("reports a network failure", async () => {
    const result = await checkHealth("http://h:1", async () => {
      throw new TypeError("Network request failed");
    });
    expect(result).toEqual({ ok: false, problem: "Not reachable (Network request failed)." });
  });

  test("gives up after the timeout", async () => {
    const result = await checkHealth(
      "http://h:1",
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Aborted")));
        }),
      20,
    );
    expect(result).toEqual({ ok: false, problem: "No answer within 0.02 s." });
  });
});
