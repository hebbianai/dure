// The chat runtime's Host-like tier, as the attention watch reads it. A chat
// Agent has no Host: its backend reads its committed conversation and runtime
// projection, and one subscription per backend sends what every chat Agent
// there is doing (`dureAgentActivity.ts`). This maps that reading onto the
// Host state shape, so display states, attention episodes and completed turns
// come from the same resolver as a terminal Agent's.
//
// Pure: no store, i18n or React.

import type { AgentTierInputs, HmuxStateInput } from "@/lib/agents/agentStateModel";
import type { DureAgentActivityV1 } from "@/lib/ipc/dureAgentActivity";
import type { Agent, AgentActivity } from "@/types";

/** What one backend's tier holds, by Agent id. */
export type StructuredAgentRuntimeTier = Readonly<
	Record<string, DureAgentActivityV1>
>;

/** Each backend profile's tier, present only while its subscription is
 * live. A backend without one (older, unreachable, or not yet subscribed)
 * has no entry. */
export type StructuredAgentRuntimeTiers = Readonly<
	Record<string, StructuredAgentRuntimeTier>
>;

export type StructuredAgentRuntimeUpdate =
	| { kind: "snapshot"; agents: readonly DureAgentActivityV1[] }
	| {
			kind: "changes";
			changes: readonly DureAgentActivityV1[];
			removed: readonly string[];
	  };

/** A backend's tier after one subscription event: a snapshot replaces it,
 * changes apply on top of it. */
export function applyStructuredAgentRuntimeUpdate(
	tier: StructuredAgentRuntimeTier | undefined,
	update: StructuredAgentRuntimeUpdate,
): StructuredAgentRuntimeTier {
	if (update.kind === "snapshot") {
		return Object.fromEntries(
			update.agents.map((activity) => [activity.agentId, activity]),
		);
	}
	const next: Record<string, DureAgentActivityV1> = { ...tier };
	for (const agentId of update.removed) delete next[agentId];
	for (const activity of update.changes) next[activity.agentId] = activity;
	return next;
}

/** The Host state a chat Agent's reading stands for. The completed-turn
 * count is the row of the newest finished turn, so the watcher's counter
 * logic records one completed-turn episode per finished turn; a new timeline
 * is a new epoch, whose smaller rows reset that baseline. */
export function structuredAgentHmuxState(
	activity: DureAgentActivityV1,
): HmuxStateInput {
	return {
		terminalEpoch: `${activity.interactionSessionId}:${activity.timelineEpoch}`,
		lifecycle: activity.lifecycle,
		activity: activity.activity,
		attention: activity.attention,
		...(activity.attentionId === undefined
			? {}
			: { attentionId: activity.attentionId }),
		source: "provider_event",
		turnCompletedCount: activity.turnCompletedSequence,
	};
}

/** The Host-like tier inputs of a chat Agent, or `undefined` for an Agent on
 * a terminal, whose Host owns them.
 *
 * With its backend's reading, the reading is the state. Without one (the
 * backend predates the tier, cannot be reached, or does not list the Agent),
 * an open pane's own presentation still shows, and an Agent with no pane
 * shows `unknown`: nothing proves it exited. */
export function structuredAgentTierInputs(
	agent: Pick<Agent, "id" | "interactionProfile">,
	tiers: StructuredAgentRuntimeTiers,
	/** The presentation lifecycle an open pane publishes, if any. */
	heuristic: AgentActivity | undefined,
): Pick<AgentTierInputs, "hmux" | "hmuxObserved"> | undefined {
	const profile = agent.interactionProfile;
	if (profile?.kind !== "structured_protocol") return undefined;
	const activity = tiers[profile.backendProfileId]?.[agent.id];
	if (activity?.interactionSessionId === profile.interactionSessionId) {
		return { hmux: structuredAgentHmuxState(activity), hmuxObserved: true };
	}
	return { hmuxObserved: heuristic === undefined ? false : undefined };
}

/** The backend profiles that host the given chat Agents: one tier
 * subscription each. */
export function structuredAgentBackendProfiles(
	agents: readonly Pick<Agent, "interactionProfile">[],
): Set<string> {
	const profiles = new Set<string>();
	for (const agent of agents) {
		if (agent.interactionProfile?.kind === "structured_protocol") {
			profiles.add(agent.interactionProfile.backendProfileId);
		}
	}
	return profiles;
}
