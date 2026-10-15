// Explaining a local stack that isn't running. The drivers' own error for a refused connection is a
// nested AggregateError with an empty message, which names neither the service nor the fix; the
// scripts and CLIs print this instead.

/** A service of the local stack (docker-compose.yml), as a script reaches it. */
export interface StackService {
  /** For people: PostGIS, RustFS. */
  readonly name: string;
  /** The variable its URL comes from: DATABASE_URL, S3_ENDPOINT. */
  readonly variable: string;
  /** Its URL. Only the host and port are ever printed, never credentials. */
  readonly url: string;
}

function walk(error: unknown, visit: (error: object) => void, depth = 0): void {
  if (typeof error !== "object" || error === null || depth > 5) return;
  visit(error);
  const { errors, cause } = error as { errors?: unknown; cause?: unknown };
  if (Array.isArray(errors)) for (const inner of errors) walk(inner, visit, depth + 1);
  walk(cause, visit, depth + 1);
}

/** True when nothing answered: the error, or one it wraps, is ECONNREFUSED. */
export function connectionRefused(error: unknown): boolean {
  let refused = false;
  walk(error, (e) => {
    if ((e as { code?: unknown }).code === "ECONNREFUSED") refused = true;
  });
  return refused;
}

/** The ports the refused connections went to, as the errors report them. */
function refusedPorts(error: unknown): Set<number> {
  const ports = new Set<number>();
  walk(error, (e) => {
    const { code, port } = e as { code?: unknown; port?: unknown };
    if (code === "ECONNREFUSED" && typeof port === "number") ports.add(port);
  });
  return ports;
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  "postgres:": 5432,
  "postgresql:": 5432,
  "http:": 80,
  "https:": 443,
};

/** host:port of a URL, or undefined when it isn't one. Never the user or password. */
function hostAndPort(url: string): { host: string; port: number | undefined } | undefined {
  try {
    const parsed = new URL(url);
    const port = parsed.port === "" ? DEFAULT_PORTS[parsed.protocol] : Number(parsed.port);
    return {
      host: parsed.port === "" && port !== undefined ? `${parsed.host}:${port}` : parsed.host,
      port,
    };
  } catch {
    return undefined;
  }
}

/**
 * For an error that says a connection was refused: which of `services` isn't listening (matched by
 * port; all of them when the error doesn't say), at which host and port, and how to start the
 * stack. Undefined for any other error.
 */
export function unreachableMessage(
  error: unknown,
  services: readonly StackService[],
): string | undefined {
  if (!connectionRefused(error)) return undefined;
  const ports = refusedPorts(error);
  const described = services.flatMap((service) => {
    const where = hostAndPort(service.url);
    if (where === undefined) return [];
    return [{ ...service, ...where }];
  });
  const matched = described.filter((s) => s.port !== undefined && ports.has(s.port));
  const named = (matched.length > 0 ? matched : described).map(
    (s) => `${s.host} (${s.name}, ${s.variable})`,
  );
  const where = named.length > 0 ? named.join(" or ") : "a service of the local stack";
  return `Nothing is listening on ${where}. Start the local stack with \`docker compose up -d --wait\`.`;
}
