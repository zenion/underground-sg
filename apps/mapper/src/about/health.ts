// GET <api>/health, with a timeout. The API doesn't exist yet on this branch, so "not reachable"
// is the normal answer for now.

export type Health =
  | { readonly ok: true; readonly status: number; readonly ms: number }
  | { readonly ok: false; readonly status?: number; readonly problem: string };

type Fetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ status: number; ok: boolean }>;

export async function checkHealth(
  baseUrl: string,
  fetchImpl: Fetch,
  timeoutMs = 3000,
  now: () => number = Date.now,
): Promise<Health> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    const response = await fetchImpl(`${baseUrl}/health`, { signal: controller.signal });
    const ms = Math.round(now() - started);
    if (response.ok) return { ok: true, status: response.status, ms };
    return { ok: false, status: response.status, problem: `Answered HTTP ${response.status}.` };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, problem: `No answer within ${timeoutMs / 1000} s.` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, problem: `Not reachable (${message}).` };
  } finally {
    clearTimeout(timer);
  }
}
