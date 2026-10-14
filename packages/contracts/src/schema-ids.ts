// Schema identifiers. Environment-neutral.

/**
 * Base of every schema's `$id`. The rest of the `$id` is the schema's path under `schemas/`, for
 * example `snapshot/indoor.schema.json`, so a relative `$ref` resolves the same way against the
 * `$id` and against the file on disk. Identifiers only: nothing fetches them.
 */
export const SCHEMA_BASE_URL = "https://underground-sg.local/schemas/";
