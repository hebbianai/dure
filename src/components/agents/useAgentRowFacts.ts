// Store wiring for one agent row: the facts about the agent itself. The list
// that shows the row supplies where it stands (its state, why it is listed,
// since when, and its Space), so pane locations are read once per list.
import { useMemo, useSyncExternalStore } from "react";
import { useConversationTitle } from "@/components/agents/chat/useConversationTitle";
import { useIndexedAgent } from "@/components/agents/useAgentIndex";
import type { AgentRowFacts } from "@/lib/agents/agentRowModel";
import { pendingApproval } from "@/lib/agents/approvalRequest";
import {
	conversationPresentationRevision,
	conversationPrompt,
	subscribeConversationPresentation,
} from "@/lib/agents/chat/conversationPresentationState";
import { programStatusNotice } from "@/lib/agents/programStatus";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { agentRowPrompt } from "@/lib/spaces/unopenedAgentPresentation";
import { observedTitle, resolveAgentPaneTitle } from "@/lib/workspace/pane/paneTitle";
import { useStore } from "@/store";

/** What the list knows about the row's place in it. */
export type AgentRowPlacement = Pick<
	AgentRowFacts,
	"state" | "needsPerson" | "hasResult" | "sinceMs" | "spaceName" | "path" | "managed"
>;

export function useAgentRowFacts(
	agentId: string,
	placement: AgentRowPlacement,
): AgentRowFacts | undefined {
	const agent = useIndexedAgent(agentId);
	const sessionId = agent?.sessionId ?? "";
	const sessionTitle = useStore((state) => state.sessionTitle[sessionId]);
	const sessionCwd = useStore((state) => state.sessionCwd[sessionId]);
	const runtime = useStore((state) => state.sessionAgentRuntimeState[sessionId]);
	const promptActivity = useStore((state) => state.sessionActivity[sessionId]);
	const projectName = useStore(
		(state) =>
			state.projects.find((project) => project.id === agent?.projectId)?.name,
	);
	const conversationTitle = useConversationTitle(agent?.id);
	const presentationRevision = useSyncExternalStore(
		subscribeConversationPresentation,
		conversationPresentationRevision,
		conversationPresentationRevision,
	);
	const prompt = useMemo(
		() =>
			agent
				? agentRowPrompt(
						promptActivity,
						conversationPrompt(agent.id, managedConversationId(agent)),
					)
				: undefined,
		[agent, promptActivity, presentationRevision],
	);
	if (!agent) return undefined;
	const waiting = placement.needsPerson !== undefined;
	const running = runtime?.lifecycle === "running";
	// What the program reports, for a row the needs-person authority put
	// here. On a result its report is history.
	const programNotice =
		waiting && running ? programStatusNotice(runtime.programStatus) : undefined;
	const approval =
		placement.needsPerson?.reason === "approval"
			? pendingApproval(runtime)?.request
			: undefined;
	return {
		...placement,
		agentId: agent.id,
		// The same title authority as the pane header and the Spaces row.
		title: resolveAgentPaneTitle({
			agent,
			runtimeTitle:
				conversationTitle ?? observedTitle(sessionTitle, agent.conversationId),
			opaqueConversationId: agent.conversationId,
			directoryCandidates: [sessionCwd, agent.worktreePath],
		}),
		...(projectName ? { projectName } : {}),
		...(programNotice ? { programNotice } : {}),
		...(approval
			? {
					approval: {
						toolName: approval.toolName,
						...(approval.summary ? { summary: approval.summary } : {}),
					},
				}
			: {}),
		...(prompt ? { prompt } : {}),
	};
}
