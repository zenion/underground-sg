// Route schemas from @usg/contracts, the source of truth for every API (CLAUDE.md). Each response
// schema is a contracts schema file inlined into one self-contained schema (`inlineSchema`), which
// @fastify/swagger turns into the OpenAPI document. Fastify's own serializer compiler
// (fast-json-stringify) is replaced: it doesn't follow JSON Schema 2020-12, and it drops unknown
// fields quietly where a contract should refuse them. Instead every JSON response is checked
// against its schema with Ajv 2020 before it is sent: a body that breaks its contract becomes a
// 500, so a private field can't slip out through a route.

import { API_SCHEMA_FILES, type ApiDocumentName } from "@usg/contracts";
import { createAjv, describeSchemaError, inlineSchema } from "@usg/contracts/validators";
import type { FastifySerializerCompiler } from "fastify";

/** A route's response schema: the contracts schema of an API document, inlined. */
export function responseSchema(document: ApiDocumentName): Record<string, unknown> {
  return inlineSchema(`api/${API_SCHEMA_FILES[document]}`);
}

/** The error body's fields, read from a plain object or from Fastify's error wrapper. */
function errorBody(data: unknown): Record<string, unknown> {
  // For a status with a schema, Fastify serializes errors as Object.create(error, {...}): the
  // fields are inherited or non-enumerable, so they are read one by one.
  const source = data as Record<string, unknown>;
  const body: Record<string, unknown> = {
    statusCode: source["statusCode"],
    error: source["error"],
    message: source["message"],
  };
  if (typeof source["code"] === "string") body["code"] = source["code"];
  return body;
}

export class ContractViolation extends Error {
  override name = "ContractViolation";
}

/**
 * Serializes a JSON response after validating it against its route's schema. Throws
 * `ContractViolation` (which Fastify turns into a 500) when the body breaks the contract.
 */
export function contractSerializerCompiler(): FastifySerializerCompiler<unknown> {
  const ajv = createAjv();
  return ({ schema, method, url, httpStatus }) => {
    const validate = ajv.compile(schema as object);
    const isError = (schema as { title?: unknown }).title === "ErrorResponse";
    return (data: unknown) => {
      const body = isError ? errorBody(data) : data;
      if (!validate(body)) {
        const problems = (validate.errors ?? []).map(describeSchemaError).join("; ");
        throw new ContractViolation(
          `${method} ${url} ${httpStatus}: the response breaks its contract: ${problems}`,
        );
      }
      return JSON.stringify(body);
    };
  };
}
