// zod -> 400 with field-level details. `parse` throws BadRequestError with {path,message}[] on
// failure so validation failures never reach the business logic; a service can trust its inputs.
// `readJson` reads+parses a request body, mapping a malformed body to a 400 rather than a crash.
import { BadRequestError } from "../errors.js";

export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new BadRequestError(
      "validation failed",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }))
    );
  }
  return result.data;
}

// Route params arrive as strings; turn an id into a positive integer or 400.
export function parseId(value, label = "id") {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestError(`invalid ${label}`);
  }
  return n;
}

export async function readJson(req) {
  let raw;
  try {
    raw = await req.text();
  } catch {
    throw new BadRequestError("invalid JSON body");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError("invalid JSON body");
  }
}
