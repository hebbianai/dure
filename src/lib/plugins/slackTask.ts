import {
	isDureDomainIdV1,
	isDureWireTokenV1,
} from "@/lib/ipc/dureProtocolIdentity";
import { asRecord } from "@/lib/payloadGuards";
import { slackConnectionContractError } from "./slackConnection";
export { openSharedAgentConversation as openSlackTask } from "@/lib/agents/chat/sharedAgentConversation";
export type { SharedAgentConversationTarget as SlackTaskConversation } from "@/lib/agents/chat/sharedAgentConversation";

export interface SlackTask {
	title?: string;
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
		...(typeof task.title === "string" ? { title: task.title } : {}),
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
