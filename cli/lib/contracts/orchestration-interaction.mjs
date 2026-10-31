import { completionRequestSchema } from "./orchestration-completion.mjs";
import { identity, object, validateOrchestrationRequest } from "./orchestration-request-schema.mjs";

// Wire shape of agent_orchestration::OpenInteractionRequest (schemaVersion 1).
const count = { type: "integer", minimum: 0 };
const tagged = (kind, properties) => object({ kind: { type: "string", const: kind }, ...properties });

const common = object({
  id: { ...identity, description: "Unique ID for this Message or Decision." },
  target: completionRequestSchema.properties.target,
  author: { ...identity, description: "Copy context.participant." },
  audience: completionRequestSchema.properties.audience,
  title: { type: "string", minLength: 1 },
  descriptionMarkdown: { type: "string", description: "Self-contained Markdown body." },
});

const response = {
  type: "object",
  description: "Text: { kind: \"text\", minBytes, maxBytes }. Select: { kind: \"select\", options, minSelections, maxSelections }.",
  oneOf: [
    tagged("text", { minBytes: count, maxBytes: { type: "integer", minimum: 1 } }),
    tagged("select", {
      options: {
        type: "array", minItems: 1,
        items: object({
          id: identity, label: { type: "string", minLength: 1 },
          descriptionMarkdown: { type: "string" },
        }, ["id", "label"]),
      },
      minSelections: count, maxSelections: { type: "integer", minimum: 1 },
    }),
  ],
};

export const interactionOpenRequestSchema = object({
  schemaVersion: { type: "integer", const: 1 },
  idempotencyKey: completionRequestSchema.properties.idempotencyKey,
  writeCapability: { ...identity, description: "Copy context.interactionCapability; keep it private." },
  expectedDispatchRevision: completionRequestSchema.properties.expectedDispatchRevision,
  openedAtMs: { type: "integer", minimum: 0, description: "Current Unix time in milliseconds, fixed across retries." },
  interaction: {
    type: "object",
    description: "A nonblocking Message (kind \"message\", purpose \"update\") or a blocking Decision (kind \"decision\"). Draft fields belong in common.",
    oneOf: [
      tagged("message", {
        common,
        purpose: { type: "string", const: "update", description: "Completion reports use orchestration_dispatch_complete." },
      }),
      tagged("decision", {
        common,
        response,
        replyCapability: { ...identity, description: "Copy context.coordinatorReplyCapability; keep it private." },
      }),
    ],
  },
});

const draftFields = Object.fromEntries(
  Object.keys(common.properties).map((key) => [key, `interaction.common.${key}`]),
);

const renamedFields = {
  body: {
    ...draftFields, interactionId: "interaction.common.id", participant: "interaction.common.author",
    kind: "interaction.kind", purpose: "interaction.purpose", response: "interaction.response",
    replyCapability: "interaction.replyCapability", interactionCapability: "writeCapability",
    dispatchRevision: "expectedDispatchRevision", expectedRevision: "expectedDispatchRevision",
  },
  "body.interaction": { ...draftFields, interactionId: "interaction.common.id" },
};

export function validateInteractionOpenRequest(body) {
  validateOrchestrationRequest(body, interactionOpenRequestSchema, {
    method: "interaction.open", tool: "orchestration_interaction_open",
    subject: "interaction.open", renamedFields,
  });
}
