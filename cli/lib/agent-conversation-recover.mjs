import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { sameAgentRuntimeFence } from "./contracts/agent-runtime.mjs";

export const AGENT_CONVERSATION_RECOVER = "agent_conversation.recover";
/** The backend's recover relaunches a provider whose process ended. Before it
 * did, recover answered with the same runtime, as for a running provider. */
export const AGENT_CONVERSATION_RECOVER_PROVIDER_EXIT = "agent_conversation.recover.provider_exit.v1";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The backend's refusal codes carry no guidance; this command owns it. */
const REFUSAL_GUIDANCE = {
  agent_conversation_conflict:
    "This Agent's runtime changed since it was read, for example it switched mode or another client recovered it. Inspect it with the Status command, then run Recover again.",
  agent_conversation_runtime_unavailable:
    "The backend could not relaunch this Agent's provider now, for example because its account needs to sign in again. Check the account in Dure's account settings, then run Recover again.",
};

function withRecoverGuidance(error) {
  if (["backend_transport_capability_missing", "backend_transport_profile_capability_missing"].includes(error.code) &&
      [AGENT_CONVERSATION_RECOVER, AGENT_CONVERSATION_RECOVER_PROVIDER_EXIT].includes(error.capability)) {
    return { ...error, message: "This backend cannot relaunch a Chat Agent whose provider ended. Update Dure on the " +
      "backend's host, then run Recover again. Nothing was restarted." };
  }
  const guidance = REFUSAL_GUIDANCE[error.remoteCode];
  return guidance ? { ...error, message: guidance } : error;
}

/**
 * Ask the backend to relaunch a Chat Agent's provider on the same conversation,
 * through the same recover the app uses. The backend owns liveness: it
 * relaunches only a provider it no longer finds running and leaves a running
 * one as it is, so a repeat never replaces a live provider. `relaunched` says
 * whether the returned binding names a new provider runtime.
 */
export async function recoverAgentConversation({
  backend, expectedBinding, requestId, deadlineMs = 45_000, requestBackend = performBackendProfileRequest,
}) {
  let response;
  try {
    response = await requestBackend(
      { ...backend.profile, deadlineMs },
      { requestId, operation: AGENT_CONVERSATION_RECOVER,
        requiredCapabilities: [AGENT_CONVERSATION_RECOVER, AGENT_CONVERSATION_RECOVER_PROVIDER_EXIT],
        body: { schemaVersion: 1, expectedBinding } },
      { ...backend.transportOptions, deadlineMs },
    );
  } catch (error) {
    return { ok: false, error: withRecoverGuidance(backendRequestFailure(error, backend.profile)) };
  }
  const binding = response?.result?.binding;
  if (!record(binding) || binding.agentId !== expectedBinding.agentId ||
      binding.interactionSessionId !== expectedBinding.interactionSessionId || !record(binding.runtime)) {
    return { ok: false, error: { code: "agent_conversation_recover_receipt_invalid",
      message: "The backend did not confirm this Agent's conversation after recovery. Inspect it with the Status command before running Recover again." } };
  }
  return { ok: true, backend: response.backend, binding,
    relaunched: !sameAgentRuntimeFence(binding.runtime, expectedBinding.runtime) };
}
