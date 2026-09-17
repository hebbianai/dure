import { parseAgentInteractionBindingV1 } from "@/lib/agents/chat/agentConversationContract";
import type { AgentStructuredInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import {
	createDureBackendRequester,
	type DureBackendInvoke,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
export interface SharedAgentConversationReference {
	agentId: string;
	backend: { backendId: string; scopeId: string | null };
}

export interface SharedAgentConversationTarget {
	agentId: string;
	profile: AgentStructuredInteractionProfileV1;
	authority: DureBackendRouteAuthorityV1;
}

/** Profile names are local to each app. Prove the durable server identity before
 * opening a shared link, then carry that exact route into the existing chat. */
export async function openSharedAgentConversation(
	task: SharedAgentConversationReference,
	profileId: string,
	invokeCommand?: DureBackendInvoke,
): Promise<SharedAgentConversationTarget> {
	const request = createDureBackendRequester({
		profileId,
		invokeCommand,
		invalidResponseCode: "shared_conversation_response_invalid",
		invalidResponseMessage: "tag.invalidResponse",
		backendChangedCode: "shared_conversation_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "shared_conversation_request_failed",
		requestFailedMessage: "tag.requestFailed",
	});
	const scope = await request(
		"backend.scope",
		{ schemaVersion: 1 },
		{ kind: "complete_selected_snapshot" },
	);
	if (
		!task.backend.scopeId ||
		scope.result.scopeId !== task.backend.scopeId ||
		scope.backend.id !== task.backend.backendId
	) {
		throw new Error("shared_conversation_server_mismatch");
	}
	const { result } = await request(
		"agent_conversation.inspect",
		{ schemaVersion: 1, agentId: task.agentId },
		{ kind: "exact", authority: scope.routeAuthority },
	);
	const binding = parseAgentInteractionBindingV1(result.binding);
	if (!binding || binding.agentId !== task.agentId)
		throw new Error("shared_conversation_response_invalid");
	return {
		agentId: task.agentId,
		authority: scope.routeAuthority,
		profile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: profileId,
			interactionSessionId: binding.interactionSessionId,
		},
	};
}
