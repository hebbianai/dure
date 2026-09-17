import { parseAgentInteractionBindingV1 } from "@/lib/agents/chat/agentConversationContract";
import type { AgentStructuredInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import {
	createDureBackendRequester,
	type DureBackendInvoke,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	isDureDomainIdV1,
	isDureWireTokenV1,
} from "@/lib/ipc/dureProtocolIdentity";
import { asRecord } from "@/lib/payloadGuards";
import { slackConnectionContractError } from "./slackConnection";

export interface SlackTask {
	teamId: string;
	channelId: string;
	threadTs: string;
	agentId: string;
	interactionSessionId: string | null;
	projectId: string;
	backend: { profileId: string; backendId: string; scopeId: string | null };
}

export function parseSlackTask(value: unknown, teamId: string): SlackTask {
	const task = asRecord(value);
	const backend = asRecord(task?.backend);
	if (
		!task ||
		task.teamId !== teamId ||
		typeof task.channelId !== "string" ||
		!/^[CGD][A-Z0-9]+$/.test(task.channelId) ||
		typeof task.threadTs !== "string" ||
		!/^\d+\.\d+$/.test(task.threadTs) ||
		!isDureDomainIdV1(task.agentId) ||
		(task.interactionSessionId !== null &&
			!isDureDomainIdV1(task.interactionSessionId)) ||
		typeof task.projectId !== "string" ||
		!backend ||
		typeof backend.profileId !== "string" ||
		!isDureWireTokenV1(backend.backendId) ||
		(backend.scopeId != null && !isDureWireTokenV1(backend.scopeId))
	)
		slackConnectionContractError();
	return {
		teamId,
		channelId: task.channelId,
		threadTs: task.threadTs,
		agentId: task.agentId,
		interactionSessionId: task.interactionSessionId,
		projectId: task.projectId,
		backend: {
			profileId: backend.profileId,
			backendId: backend.backendId,
			scopeId: backend.scopeId ?? null,
		},
	};
}

export interface SlackTaskConversation {
	agentId: string;
	profile: AgentStructuredInteractionProfileV1;
	authority: DureBackendRouteAuthorityV1;
}

/** Profile names are local to each app. Prove the durable server identity before
 * opening a shared link, then carry that exact route into the existing chat. */
export async function openSlackTask(
	task: SlackTask,
	profileId: string,
	invokeCommand?: DureBackendInvoke,
): Promise<SlackTaskConversation> {
	const request = createDureBackendRequester({
		profileId,
		invokeCommand,
		invalidResponseCode: "slack_task_response_invalid",
		invalidResponseMessage: "plugins.slack.invalidResponse",
		backendChangedCode: "slack_task_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "slack_task_request_failed",
		requestFailedMessage: "plugins.slack.requestFailed",
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
		throw new Error("slack_task_server_mismatch");
	}
	const { result } = await request(
		"agent_conversation.inspect",
		{ schemaVersion: 1, agentId: task.agentId },
		{ kind: "exact", authority: scope.routeAuthority },
	);
	const binding = parseAgentInteractionBindingV1(result.binding);
	if (
		!binding ||
		binding.agentId !== task.agentId ||
		(task.interactionSessionId &&
			binding.interactionSessionId !== task.interactionSessionId)
	)
		slackConnectionContractError();
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
