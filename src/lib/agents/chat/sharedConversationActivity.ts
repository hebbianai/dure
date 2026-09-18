import type { SharedAgentConversationReference } from "@/lib/agents/chat/sharedAgentConversation";
import { createDureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import {
	createDureBackendRequester,
	type DureBackendInvoke,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

/** Read activity from the conversation owner without opening a pane or waking
 * a provider. Missing entries are unobserved, never evidence of completion. */
export async function readSharedConversationActivity(
	references: readonly SharedAgentConversationReference[],
	authority: DureBackendRouteAuthorityV1,
	options?: { invokeCommand?: DureBackendInvoke; signal?: AbortSignal },
): Promise<ReadonlyMap<string, boolean>> {
	const activity = new Map<string, boolean>();
	if (references.length === 0 || options?.signal?.aborted) return activity;
	const request = createDureBackendRequester({
		profileId: authority.profileId,
		invokeCommand: options?.invokeCommand,
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
		{ kind: "exact", authority },
	);
	const referencesByAgent = new Map(
		references
			.filter(
				(reference) =>
					reference.backend.scopeId &&
					reference.backend.scopeId === scope.result.scopeId &&
					reference.backend.backendId === scope.backend.id,
			)
			.map((reference) => [reference.agentId, reference]),
	);
	const agents = [...referencesByAgent.keys()];
	let next = 0;
	async function observe() {
		while (next < agents.length && !options?.signal?.aborted) {
			const agentId = agents[next++];
			try {
				const client = createDureAgentConversationClient({
					profileId: authority.profileId,
					routeAuthority: authority,
					invokeCommand: options?.invokeCommand,
				});
				// Resolve the current binding: an account/runtime switch may have
				// replaced the conversation recorded in the original Slack link.
				const { binding } = await client.inspect(agentId);
				if (!binding || options?.signal?.aborted) continue;
				const { read } = await client.read({
					schemaVersion: 1,
					interactionSessionId: binding.interactionSessionId,
					direction: "tail",
					cursor: null,
					limit: 1,
				});
				if (read.type === "page" && read.page.binding.agentId === agentId) {
					activity.set(
						agentId,
						read.page.activeTurn !== null &&
							read.page.pendingRequests.length === 0,
					);
				}
			} catch {
				// One unavailable task does not hide the other tasks' observations.
			}
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(4, agents.length) }, observe),
	);
	return activity;
}
