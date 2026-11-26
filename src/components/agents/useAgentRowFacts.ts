// Store wiring for one agent row: the facts about the agent itself, where it
// stands among the agents that manage it and what it manages. The list that
// shows the row supplies where it stands in that list (its state, why it is
// listed, since when, its Space, and the agent the list sits under), so pane
// locations are read once per list.
import { useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { agentIndexOf, useIndexedAgent } from "@/components/agents/useAgentIndex";
import {
	useAgentManagedSummary,
	useAgentRelations,
} from "@/components/agents/useAgentRelations";
import type { AgentRowFacts } from "@/lib/agents/agentRowModel";
import { pendingApproval } from "@/lib/agents/approvalRequest";
import {
	conversationPresentationRevision,
	conversationPrompt,
	conversationTitle,
	subscribeConversationPresentation,
} from "@/lib/agents/chat/conversationPresentationState";
import { programStatusNotice } from "@/lib/agents/programStatus";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { agentRowPrompt } from "@/lib/spaces/unopenedAgentPresentation";
import { observedTitle, resolveAgentPaneTitle } from "@/lib/workspace/pane/paneTitle";
import { type AppState, useStore } from "@/store";
import type { Agent } from "@/types";

/** What the list knows about the row's place in it. */
export type AgentRowPlacement = Pick<
	AgentRowFacts,
	"state" | "needsPerson" | "hasResult" | "sinceMs" | "spaceName"
> & {
	/** The agent the list sits under, as a manager's team line does: the
	 * row's path then names only the managers below it. */
	readonly below?: string;
};

/** The same title authority as the pane header and the Spaces row. */
function agentRowTitle(
	agent: Agent,
	state: Pick<AppState, "sessionTitle" | "sessionCwd">,
): string {
	return resolveAgentPaneTitle({
		agent,
		runtimeTitle:
			conversationTitle(agent.id) ??
			observedTitle(state.sessionTitle[agent.sessionId], agent.conversationId),
		opaqueConversationId: agent.conversationId,
		directoryCandidates: [state.sessionCwd[agent.sessionId], agent.worktreePath],
	});
}

export function useAgentRowFacts(
	agentId: string,
	{ below, ...placement }: AgentRowPlacement,
): AgentRowFacts | undefined {
	const agent = useIndexedAgent(agentId);
	const sessionId = agent?.sessionId ?? "";
	const runtime = useStore((state) => state.sessionAgentRuntimeState[sessionId]);
	const promptActivity = useStore((state) => state.sessionActivity[sessionId]);
	const projectName = useStore(
		(state) =>
			state.projects.find((project) => project.id === agent?.projectId)?.name,
	);
	// Titles read provider-reported conversation titles too, so a new one
	// re-renders the row.
	const presentationRevision = useSyncExternalStore(
		subscribeConversationPresentation,
		conversationPresentationRevision,
		conversationPresentationRevision,
	);
	const title = useStore((state) =>
		agent ? agentRowTitle(agent, state) : undefined,
	);
	const relations = useAgentRelations();
	const managerIds = useMemo(
		() => relations.chain(agentId, below),
		[relations, agentId, below],
	);
	const path = useStore(
		useShallow((state) => {
			const agents = agentIndexOf(state.agents);
			return managerIds.flatMap((id) => {
				const manager = agents.get(id);
				return manager ? [agentRowTitle(manager, state)] : [];
			});
		}),
	);
	const managed = useAgentManagedSummary(agentId);
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
	if (!agent || title === undefined) return undefined;
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
		title,
		...(projectName ? { projectName } : {}),
		...(path.length > 0 ? { path } : {}),
		...(managed ? { managed } : {}),
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
