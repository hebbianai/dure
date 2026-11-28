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
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import type { AgentRowFacts } from "@/lib/agents/agentRowModel";
import { pendingApproval } from "@/lib/agents/approvalRequest";
import {
	conversationPresentationRevision,
	conversationPrompt,
	conversationTitle,
	subscribeConversationPresentation,
} from "@/lib/agents/chat/conversationPresentationState";
import { programStatusNotice } from "@/lib/agents/programStatus";
import {
	isShellRowKey,
	type ShellRelationNode,
	shellRelationNodesOf,
} from "@/lib/agents/relations/shellRelationNodes";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { shellRowTitle } from "@/lib/spaces/shellRowTitle";
import { agentRowPrompt } from "@/lib/spaces/unopenedAgentPresentation";
import { getTerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocationStore";
import { observedTitle, resolveAgentPaneTitle } from "@/lib/workspace/pane/paneTitle";
import { type AppState, useStore } from "@/store";
import type { Agent } from "@/types";

/** What the list knows about the row's place in it. */
export type AgentRowPlacement = Pick<
	AgentRowFacts,
	| "state"
	| "needsPerson"
	| "hasResult"
	| "unread"
	| "sinceMs"
	| "branch"
	| "spaceName"
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

/** The same title as the plain shell's Spaces row. */
function shellNodeTitle(
	shell: ShellRelationNode,
	state: Pick<AppState, "sessionAgentPin" | "sessionAgent" | "sessionCwd">,
): string {
	const id = shell.terminalSessionId;
	const location = getTerminalExecutionLocation(id);
	return shellRowTitle({
		sshTarget: location?.kind === "ssh" ? location.target : undefined,
		provider: state.sessionAgentPin[id] ?? state.sessionAgent[id] ?? null,
		cwd: state.sessionCwd[id] || shell.cwd || "",
	});
}

/** The title every row shows for each relation node in `keys` — an Agent,
 * or a plain shell row — in the same order; undefined for a key that names
 * neither. */
export function useAgentRowTitles(
	keys: readonly string[],
): readonly (string | undefined)[] {
	return useStore(
		useShallow((state) => {
			const agents = agentIndexOf(state.agents);
			const shells = keys.some(isShellRowKey)
				? new Map(shellRelationNodesOf(state).map((shell) => [shell.key, shell]))
				: undefined;
			return keys.map((key) => {
				const agent = agents.get(key);
				if (agent) return agentRowTitle(agent, state);
				const shell = shells?.get(key);
				return shell ? shellNodeTitle(shell, state) : undefined;
			});
		}),
	);
}

export function useAgentRowFacts(
	agentId: string,
	{ below, ...placement }: AgentRowPlacement,
): AgentRowFacts | undefined {
	const agent = useIndexedAgent(agentId);
	const sessionId = agent?.sessionId ?? "";
	const runtime = useStore((state) => state.sessionAgentRuntimeState[sessionId]);
	const promptActivity = useStore((state) => state.sessionActivity[sessionId]);
	const continuesAtMs = useAgentAttention((state) => state.recoveryWaits[agentId]);
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
	const managerTitles = useAgentRowTitles(managerIds);
	const path = useMemo(
		() => managerTitles.filter((title) => title !== undefined),
		[managerTitles],
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
		...(continuesAtMs === undefined ? {} : { continuesAtMs }),
	};
}
