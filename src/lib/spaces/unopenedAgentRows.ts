import { isAgentUnread } from "@/lib/agents/agentAttentionStore";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import {
	type AgentDisplayState,
	presentedAgentDisplayState,
} from "@/lib/agents/agentStateModel";
import type { ProviderConversationRecord } from "@/lib/agents/providerConversationDiscovery";
import { pathBasename } from "@/lib/files/paths";
import { projectIndexFor } from "@/lib/spaces/projectIndex";
import { compareUnopenedAgents } from "@/lib/spaces/spacesDisplay";
import {
	matchesSpacesQuery,
	unopenedAgentSearchParts,
} from "@/lib/spaces/spacesSearch";
import {
	resolveUnopenedAgentPresentation,
	type UnopenedAgentConversationIndex,
	unopenedAgentConversation,
} from "@/lib/spaces/unopenedAgentPresentation";
import {
	type HiddenUnopenedAgent,
	isUnopenedAgentHidden,
} from "@/lib/spaces/unopenedAgentVisibility";
import type { Agent, AgentActivity, Project } from "@/types";

/** One row of the unopened-agent queue, as the Spaces pane draws it. */
export interface UnopenedAgentRow {
	readonly agent: Agent;
	readonly displayName: string;
	/** The stable agent name, reserved for sorting; the display name may be
	 * a conversation title that changes. */
	readonly sortName: string;
	readonly conversation: ProviderConversationRecord | undefined;
	readonly state: AgentDisplayState;
	readonly unread: boolean;
	readonly projectName: string;
	/** The repository head row above names the project; the info line keeps
	 * only the branch (same rule as the open rows). */
	readonly detail: string;
}

export interface UnopenedAgentRowsInput {
	/** Registered agents with no open pane, hidden panes already excluded. */
	readonly candidates: readonly Agent[];
	readonly projects: readonly Project[];
	readonly conversationIndex: UnopenedAgentConversationIndex;
	readonly activity: Readonly<Record<string, AgentActivity>>;
	readonly displayStates: Readonly<Record<string, AgentDisplayState>>;
	readonly episodes: Readonly<Record<string, number>>;
	readonly acks: Readonly<Record<string, number>>;
	/** Already normalized by normalizeSpacesQuery. */
	readonly normalizedQuery: string;
	/** Rows the user hid, with the episode observed at hide time. */
	readonly hidden: readonly HiddenUnopenedAgent[];
}

/** The unopened queue the Spaces pane shows: which candidates are visible,
 * how each is presented, in what order, and how many search matches the user
 * has hidden. Attention events (episodes/acks) legitimately recompute this,
 * so per-candidate work stays O(1): shared project/conversation indexes
 * instead of array scans. */
export function unopenedAgentRows(input: UnopenedAgentRowsInput): {
	readonly visible: readonly UnopenedAgentRow[];
	readonly hiddenCount: number;
} {
	const projectById = projectIndexFor(input.projects).byId;
	const rows = input.candidates
		.map((agent): UnopenedAgentRow => {
			const project = projectById.get(agent.projectId);
			const projectName = project?.name ?? pathBasename(agent.worktreePath);
			const conversation = unopenedAgentConversation(
				input.conversationIndex,
				agent,
				project,
			);
			return {
				agent,
				displayName: resolveUnopenedAgentPresentation({ agent, conversation })
					.title,
				sortName: agentDisplayName(agent),
				conversation,
				state: presentedAgentDisplayState(
					input.displayStates[agent.id],
					input.activity[agent.id],
				),
				unread: isAgentUnread(input.episodes, input.acks, agent.id),
				projectName,
				detail: agent.branch ?? "",
			};
		})
		.filter(({ agent, displayName, projectName }) =>
			matchesSpacesQuery(
				input.normalizedQuery,
				unopenedAgentSearchParts({
					displayName,
					name: agent.name,
					provider: agent.provider,
					projectName,
					worktreePath: agent.worktreePath,
					branch: agent.branch,
				}),
			),
		);
	// A hidden row returns on its own once a newer attention episode than the
	// one observed at hide time arrives — the same "new activity revives it"
	// rule the detected-worktree section uses.
	const visible = rows
		.filter(
			({ agent }) =>
				!isUnopenedAgentHidden(
					{ id: agent.id, episode: input.episodes[agent.id] ?? 0 },
					input.hidden,
				),
		)
		.sort((a, b) =>
			compareUnopenedAgents(
				{ unread: a.unread, state: a.state, name: a.sortName },
				{ unread: b.unread, state: b.state, name: b.sortName },
			),
		);
	return { visible, hiddenCount: rows.length - visible.length };
}
