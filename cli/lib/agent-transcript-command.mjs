import {
  collectAgentTranscript,
  formatAgentTranscript,
} from "./agent-transcript.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";

const AGENT_CONVERSATION_INSPECT = "agent_conversation.inspect";
const AGENT_CONVERSATION_READ = "agent_conversation.read";
const AGENT_CONVERSATION_READ_CAPABILITY = "agent_conversation.read.v7";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message) {
  const error = new Error(message);
  error.code = "agent_transcript_backend_response_invalid";
  throw error;
}

function inspectBinding(result, agentId, expectedInteractionSessionId) {
  const binding = record(result) && record(result.binding) ? result.binding : null;
  if (
    !binding ||
    binding.schemaVersion !== 1 ||
    binding.agentId !== agentId ||
    typeof binding.interactionSessionId !== "string" ||
    (expectedInteractionSessionId !== undefined &&
      binding.interactionSessionId !== expectedInteractionSessionId)
  ) {
    invalid(
      binding
        ? "The Agent conversation identity no longer matches this request."
        : "This Agent has no structured conversation transcript.",
    );
  }
  return binding;
}

export async function collectBackendAgentTranscript({
  agentId,
  backend,
  deadlineMs,
  entryLimit,
  expectedInteractionSessionId,
  requestBackend = performBackendProfileRequest,
  signal,
} = {}) {
  if (
    typeof agentId !== "string" ||
    !DOMAIN_ID.test(agentId) ||
    (expectedInteractionSessionId !== undefined &&
      (typeof expectedInteractionSessionId !== "string" ||
        !DOMAIN_ID.test(expectedInteractionSessionId)))
  ) {
    invalid("The Agent transcript identity is invalid.");
  }
  if (backend?.error) throw backend.error;
  const profile = backend?.profile;
  if (!profile) invalid("No backend profile is available for this Agent.");

  const transportOptions = {
    ...backend.transportOptions,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    maxResponseBytes: MAX_RESPONSE_BYTES,
    signal,
  };
  const inspected = await requestBackend(
    profile,
    {
      operation: AGENT_CONVERSATION_INSPECT,
      requiredCapabilities: [AGENT_CONVERSATION_INSPECT],
      body: { schemaVersion: 1, agentId },
    },
    transportOptions,
  );
  const binding = inspectBinding(
    inspected.result,
    agentId,
    expectedInteractionSessionId,
  );

  return collectAgentTranscript({
    agentId: binding.agentId,
    providerId: binding.providerId,
    interactionSessionId: binding.interactionSessionId,
    entryLimit,
    readPage: async (request) => {
      const response = await requestBackend(
        profile,
        {
          operation: AGENT_CONVERSATION_READ,
          requiredCapabilities: [AGENT_CONVERSATION_READ_CAPABILITY],
          body: request,
        },
        transportOptions,
      );
      if (!record(response.result) || !("read" in response.result)) {
        invalid("The Agent transcript read response is invalid.");
      }
      return response.result.read;
    },
  });
}

export function formatBackendAgentTranscript(transcript, { json = false } = {}) {
  return formatAgentTranscript(transcript, { json });
}
