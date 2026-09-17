import crypto from "node:crypto";
import {
  createOrchestrationRequest,
  requestOrchestration,
} from "./orchestration-client.mjs";
import { resolveSuccessorDispatchContext } from "./orchestration-lifecycle.mjs";
import { BackendTransportError } from "./backend-transport.mjs";

const MAX_CANDIDATES = 3;
const MAX_SUMMARY_BYTES = 480;
const SUMMARY_FIELDS = ["title", "benefit", "concern", "prerequisite", "conflictSurface"];

export const nextWorkCandidatesSchema = {
  type: "array",
  minItems: 1,
  maxItems: MAX_CANDIDATES,
  description:
    "Optional caller-supplied recommendations in priority order. Omit to complete without a successor Decision. Dure does not query or claim tracker work.",
  items: {
    type: "object",
    required: ["id", ...SUMMARY_FIELDS],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 256 },
      ...Object.fromEntries(
        SUMMARY_FIELDS.map((field) => [field, { type: "string", minLength: 1 }]),
      ),
    },
    additionalProperties: false,
  },
};

function boundedReference(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/\p{Cc}/u.test(value)
  );
}

function boundedText(value, maximumBytes = MAX_SUMMARY_BYTES) {
  if (typeof value !== "string") return "";
  const normalized = value
    .replaceAll(/\p{Cc}+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (Buffer.byteLength(normalized, "utf8") <= maximumBytes) return normalized;
  let prefix = "";
  let prefixBytes = 0;
  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (prefixBytes + characterBytes > maximumBytes - 3) break;
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix.trimEnd()}...`;
}

export function parseNextWorkCandidates(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CANDIDATES) {
    throw new Error(`nextWorkCandidates must contain 1 to ${MAX_CANDIDATES} recommendations`);
  }
  const ids = new Set();
  return value.map((candidate, index) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).some((key) => key !== "id" && !SUMMARY_FIELDS.includes(key))
    ) {
      throw new Error(`nextWorkCandidates[${index}] must contain only recommendation fields`);
    }
    if (!boundedReference(candidate.id) || candidate.id === "stop" || ids.has(candidate.id)) {
      throw new Error(`nextWorkCandidates[${index}].id must be unique, bounded, and not stop`);
    }
    ids.add(candidate.id);
    return {
      id: candidate.id,
      ...Object.fromEntries(
        SUMMARY_FIELDS.map((field) => {
          const text = boundedText(candidate[field]);
          if (!text) {
            throw new Error(`nextWorkCandidates[${index}].${field} must be nonempty text`);
          }
          return [field, text];
        }),
      ),
    };
  });
}

function nextWorkIdentity(target) {
  const source = JSON.stringify([
    "dure.next-work-decision/v1",
    target?.authority?.workspaceId,
    target?.authority?.tenantRef ?? null,
    target?.dispatchId,
    target?.generation,
  ]);
  return crypto.createHash("sha256").update(source).digest("hex");
}

function decisionDescription() {
  return (
    "The preceding completion report committed before this Decision. " +
    "The caller supplied these recommendations; Dure did not query a tracker or reserve work. " +
    "The completion report remains the source for its Git and CI/test evidence. " +
    "After an answer, the agent must revalidate the selected work against its authoritative source and satisfy its prerequisites and coordination requirements before starting. If it is stale, explain that and request a fresh choice."
  );
}

function decisionOptions(candidates) {
  return [
    ...candidates.map((candidate) => ({
      id: candidate.id,
      label: boundedText(`${candidate.id} — ${candidate.title}`, 480),
      descriptionMarkdown:
        `Benefit: ${candidate.benefit}\n\n` +
        `Concern: ${candidate.concern}\n\n` +
        `Prerequisite: ${candidate.prerequisite}\n\n` +
        `Likely conflict surface: ${candidate.conflictSurface}`,
    })),
    {
      id: "stop",
      label: "Stop here",
      descriptionMarkdown:
        "Benefit: leaves the completed work as-is.\n\n" +
        "Concern: suggested follow-up work remains unstarted.\n\n" +
        "Prerequisite: none.\n\n" +
        "Likely conflict surface: none.",
    },
  ];
}

function missingInteraction(error) {
  return (
    error instanceof BackendTransportError &&
    error.code === "backend_transport_remote_error" &&
    error.details?.code === "orchestration_record_not_found"
  );
}

export async function publishNextWorkDecision({
  completionBody,
  candidates,
  endpoint,
  environment = process.env,
  integrationReceipt,
  receiptPath,
  request = requestOrchestration,
  now = Date.now,
} = {}) {
  const resolveSuccessor = async () => {
    const context = await resolveSuccessorDispatchContext(
      environment,
      completionBody.target,
      {
        integrationReceipt,
        receiptPath,
        request,
        now,
      },
    );
    if (!context) throw new Error("current managed Session identity is unavailable");
    return context;
  };
  const successor = await resolveSuccessor();

  const identity = nextWorkIdentity(completionBody.target);
  const interactionId = `next-work-${identity}`;
  const options = {
    authorization: environment.DURE_ORCHESTRATION_AUTHORIZATION,
    environment,
  };
  try {
    const existing = await request(
      endpoint,
      createOrchestrationRequest({
        method: "interaction.get",
        body: {
          schemaVersion: 1,
          authority: successor.target.authority,
          interactionId,
          participant: successor.coordinatorGrant.participant,
          readCapability: successor.coordinatorGrant.deliveryCapability,
        },
      }),
      options,
    );
    return {
      state: "existing",
      interactionId,
      target: successor.target,
      interaction: existing.receipt,
      context: successor,
    };
  } catch (error) {
    if (!missingInteraction(error)) throw error;
  }

  const opened = await request(
    endpoint,
    createOrchestrationRequest({
      method: "interaction.open",
      body: {
        schemaVersion: 1,
        idempotencyKey: `next-work-${identity}`,
        writeCapability: successor.interactionCapability,
        expectedDispatchRevision: successor.dispatchRevision,
        openedAtMs: completionBody.completedAtMs,
        interaction: {
          kind: "decision",
          common: {
            id: interactionId,
            target: successor.target,
            author: successor.participant,
            audience: { grants: [successor.coordinatorGrant] },
            title: "Choose what to work on next",
            descriptionMarkdown: decisionDescription(),
          },
          response: {
            kind: "select",
            options: decisionOptions(candidates),
            minSelections: 1,
            maxSelections: 1,
          },
          replyCapability: successor.coordinatorReplyCapability,
        },
      },
    }),
    options,
  );
  const blockedSuccessor = await resolveSuccessor();
  return {
    state: opened.receipt?.idempotent ? "existing" : "opened",
    interactionId,
    target: successor.target,
    interaction: opened.receipt?.interaction,
    context: blockedSuccessor,
    candidateIds: candidates.map((candidate) => candidate.id),
  };
}
