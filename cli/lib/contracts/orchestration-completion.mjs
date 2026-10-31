import { identity, object, revision, validateOrchestrationRequest } from "./orchestration-request-schema.mjs";

// Wire shape of agent_orchestration::CompleteDispatchRequest (schemaVersion 1).
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

export function validateCompletionRequest(body) {
  validateOrchestrationRequest(body, completionRequestSchema, {
    method: "dispatch.complete", tool: "orchestration_dispatch_complete",
    subject: "completion", renamedFields: { body: renamedFields },
  });
}
