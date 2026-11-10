import { completionRequestSchema } from "./orchestration-completion.mjs";
import { identity, object, revision, validateOrchestrationRequest } from "./orchestration-request-schema.mjs";

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

// Wire shape of agent_orchestration::AnswerDecisionRequest (schemaVersion 1).
// The answerer is the Decision's audience, which is the coordinator grant.
export const answerDecisionRequestSchema = object({
  schemaVersion: { type: "integer", const: 1 },
  idempotencyKey: completionRequestSchema.properties.idempotencyKey,
  interactionId: { ...identity, description: "Copy the Decision's common.id." },
  target: { ...completionRequestSchema.properties.target, description: "Copy the Decision's Dispatch context.target verbatim." },
  expectedRevision: { ...revision, description: "Copy the Decision's common.revision; do not guess or increment it." },
  expectedDispatchRevision: {
    ...revision,
    description: "Copy context.dispatchRevision of the Dispatch the Decision blocks; do not guess or increment it.",
  },
  answeredBy: { ...identity, description: "Copy context.coordinatorGrant.participant, the Decision's audience." },
  replyCapability: { ...identity, description: "Copy context.coordinatorReplyCapability; keep it private." },
  answer: {
    type: "object",
    description: "Text: { kind: \"text\", value }. Select: { kind: \"select\", optionIds } with ids from the Decision's response.options.",
    oneOf: [
      tagged("text", { value: { type: "string" } }),
      tagged("select", { optionIds: { type: "array", items: identity } }),
    ],
  },
  answeredAtMs: { type: "integer", minimum: 0, description: "Current Unix time in milliseconds, fixed across retries." },
});

const answerRenamedFields = {
  body: {
    decisionId: "interactionId", id: "interactionId",
    revision: "expectedRevision", dispatchRevision: "expectedDispatchRevision",
    participant: "answeredBy", author: "answeredBy",
    interactionCapability: "replyCapability", writeCapability: "replyCapability",
    coordinatorReplyCapability: "replyCapability",
    kind: "answer.kind", value: "answer.value", optionIds: "answer.optionIds",
  },
  "body.answer": { optionId: "optionIds", options: "optionIds", text: "value" },
};

export function validateAnswerDecisionRequest(body) {
  validateOrchestrationRequest(body, answerDecisionRequestSchema, {
    method: "interaction.answer", tool: "orchestration_decision_answer",
    subject: "interaction.answer", renamedFields: answerRenamedFields,
  });
}
