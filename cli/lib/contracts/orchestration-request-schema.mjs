// Shared building blocks for published orchestration request schemas. The
// service remains authoritative for capabilities, revisions and byte limits.
export const identity = { type: "string", minLength: 1 };
export const revision = { type: "integer", minimum: 1 };
export const object = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});

const MAX_REPORTED_ERRORS = 16;

// A oneOf is a tagged union: every variant fixes the same property with const.
function discriminator(variants) {
  return Object.keys(variants[0].properties).find((key) =>
    variants.every((variant) => variant.properties[key]?.const !== undefined));
}

const expectedValues = (values) => values.map((value) => JSON.stringify(value)).join(" or ");

// Walk only the published schema. Error paths come from schema keys, never from
// caller-supplied values or unknown keys that could contain private material.
function validate(value, schema, path, report, renamedFields) {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((expected) => expected === "integer" ? Number.isSafeInteger(value) : expected === type)) {
    return report(path, `must be ${types.join(" or ")}`);
  }
  if (schema.const !== undefined && value !== schema.const) return report(path, `must be ${JSON.stringify(schema.const)}`);
  if (schema.minimum !== undefined && value < schema.minimum) report(path, `must be at least ${schema.minimum}`);
  if (type === "string" && schema.minLength && !value.length) report(path, "must not be empty");
  if (schema.oneOf) {
    const key = discriminator(schema.oneOf);
    const tags = schema.oneOf.map((variant) => variant.properties[key].const);
    const variant = schema.oneOf.find((candidate) => candidate.properties[key].const === value[key]);
    if (!Object.hasOwn(value, key)) return report(`${path}.${key}`, `is required (${expectedValues(tags)})`);
    if (!variant) return report(`${path}.${key}`, `must be ${expectedValues(tags)}`);
    return validate(value, variant, path, report, renamedFields);
  }
  if (type === "array") {
    if (value.length < (schema.minItems ?? 0)) report(path, `must contain at least ${schema.minItems} item`);
    value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`, report, renamedFields));
  } else if (type === "object") {
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key)) report(`${path}.${key}`, "is required");
    }
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(schema.properties, key)) {
        validate(value[key], schema.properties[key], `${path}.${key}`, report, renamedFields);
        continue;
      }
      const replacement = renamedFields.fields[path]?.[key];
      report(path, replacement
        ? `uses ${key}; the ${renamedFields.subject} field is ${replacement}`
        : `contains an unknown field (allowed: ${Object.keys(schema.properties).join(", ")})`);
    }
  }
}

/**
 * Rejects a body that cannot match the published schema, naming every failing
 * path (bounded) so the caller can correct it in one attempt.
 */
export function validateOrchestrationRequest(body, schema, { method, tool, subject, renamedFields = {} }) {
  const errors = [];
  const report = (path, reason) => {
    const error = { path, message: `${path} ${reason}` };
    if (errors.length < MAX_REPORTED_ERRORS && !errors.some((entry) => entry.message === error.message)) {
      errors.push(error);
    }
  };
  validate(body, schema, "body", report, { subject, fields: renamedFields });
  if (errors.length === 0) return;
  throw Object.assign(new Error(
    `${method}: ${errors.map((error) => error.message).join(". ")}. Correct the body using ${tool}'s input schema or the dure-orchestration skill; an unchanged invalid request will not succeed.`,
  ), { code: "orchestration_request_invalid", field: errors[0].path, disposition: "terminal" });
}
