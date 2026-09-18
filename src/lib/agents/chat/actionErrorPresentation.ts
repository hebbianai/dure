import { t } from "@/lib/i18n";

/** Backend failure tokens the composer banner can explain in words. The raw
 * token stays attached as the diagnostic detail — humanizing must never cost
 * the one fact an operator needs (the 2026-08-27 outage was prolonged by a
 * masked reason). An unrecognized token renders verbatim. */
const KNOWN_ACTION_ERRORS: Record<string, string> = {
	agent_chat_queue_edit_backend_changed:
		"agents.chat.error.queuedEditBackendChanged",
	agent_chat_queue_edit_input_unavailable:
		"agents.chat.error.queuedEditInputUnavailable",
	agent_conversation_provider_failed: "agents.chat.error.providerFailed",
	agent_conversation_runtime_unavailable:
		"agents.chat.error.runtimeUnavailable",
	agent_conversation_conflict: "agents.chat.error.conflict",
	agent_conversation_not_found: "agents.chat.error.notFound",
	agent_conversation_request_invalid: "agents.chat.error.requestInvalid",
	agent_conversation_store_failed: "agents.chat.error.storeFailed",
	backend_request_deadline_exceeded: "agents.chat.error.deadline",
};

export interface ActionErrorPresentation {
	/** Human sentence when the token is catalogued; the token itself otherwise. */
	readonly message: string;
	/** The raw backend token, kept when it is not already the message. */
	readonly detail?: string;
}

export function presentActionError(raw: string): ActionErrorPresentation {
	const key = KNOWN_ACTION_ERRORS[raw];
	if (!key) return { message: raw };
	return { message: t(key), detail: raw };
}
