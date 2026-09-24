// Wire shape of agent_orchestration::CompleteDispatchRequest (schemaVersion 1).
// The service remains authoritative for capabilities, revisions and byte limits.
const identity = { type: "string", minLength: 1 };
const revision = { type: "integer", minimum: 1 };
const object = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});

export const completionRequestSchema = object({
  schemaVersion: { type: "integer", const: 1 },
  idempotencyKey: { ...identity, description: "Keep this key and the complete body unchanged after an uncertain response." },
  messageId: { ...identity, description: "Unique ID for the completion Message." },
  target: { ...object({
    authority: object({ workspaceId: identity, tenantRef: { type: ["string", "null"], minLength: 1 } }, ["workspaceId"]),
    runId: identity, taskId: identity, dispatchId: identity, generation: revision,
  }), description: "Copy context.target from orchestration_context_get_current verbatim." },
  expectedDispatchRevision: { ...revision, description: "Copy context.dispatchRevision; do not guess or increment it." },
  completedBy: { ...identity, description: "Copy context.participant." },
  endpointFence: { ...object({
    endpointRef: identity, sessionIdentity: identity, generation: revision,
    deliveryCapability: identity, acknowledgementCapability: identity,
  }), description: "Copy context.endpointFence verbatim, including its private capabilities." },
  audience: object({ grants: {
    type: "array", minItems: 1,
    description: "Use [context.coordinatorGrant] to report to this Dispatch's coordinator.",
    items: object({
      membershipRef: identity, participant: identity,
      roles: { type: "array", items: identity },
      capabilities: { type: "array", items: identity },
      deliveryCapability: identity,
    }, ["membershipRef", "participant", "capabilities", "deliveryCapability"]),
  } }),
  completionCapability: { ...identity, description: "Copy context.completionCapability; keep it private." },
  title: { type: "string", minLength: 1 },
  resultMarkdown: { type: "string", description: "Self-contained completion report in Markdown." },
  completedAtMs: { type: "integer", minimum: 0, description: "Current Unix time in milliseconds, fixed across retries." },
});

const renamedFields = {
  participant: "completedBy", dispatchRevision: "expectedDispatchRevision",
  expectedRevision: "expectedDispatchRevision", interactionId: "messageId",
  reportMarkdown: "resultMarkdown", descriptionMarkdown: "resultMarkdown",
};

function invalid(path, reason) {
  throw Object.assign(new Error(
    `dispatch.complete: ${path} ${reason}. Correct the body using orchestration_dispatch_complete's input schema or the dure-orchestration skill; an unchanged invalid request will not succeed.`,
  ), { code: "orchestration_request_invalid", field: path, disposition: "terminal" });
}

// Walk only the published schema. Error paths come from schema keys, never from
// caller-supplied values or unknown keys that could contain private material.
function validate(value, schema, path) {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((expected) => expected === "integer" ? Number.isSafeInteger(value) : expected === type)) {
    invalid(path, `must be ${types.join(" or ")}`);
  }
  if (schema.const !== undefined && value !== schema.const) invalid(path, `must be ${schema.const}`);
  if (schema.minimum !== undefined && value < schema.minimum) invalid(path, `must be at least ${schema.minimum}`);
  if (type === "string" && schema.minLength && !value.length) invalid(path, "must not be empty");
  if (type === "array") {
    if (value.length < (schema.minItems ?? 0)) invalid(path, `must contain at least ${schema.minItems} item`);
    value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`));
  } else if (type === "object") {
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, "is required");
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) {
        const replacement = path === "body" && Object.hasOwn(renamedFields, key) ? renamedFields[key] : null;
        invalid(path, replacement
          ? `uses ${key}; the completion field is ${replacement}`
          : `contains an unknown field (allowed: ${Object.keys(schema.properties).join(", ")})`);
      }
      validate(value[key], schema.properties[key], `${path}.${key}`);
    }
  }
}

export function validateCompletionRequest(body) {
  validate(body, completionRequestSchema, "body");
}
