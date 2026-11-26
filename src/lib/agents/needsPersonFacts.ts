// The window's needs-person map, read from the stores. Every reader — the
// rail badge, Next up, the Dock badge and the Spaces rows — goes through the
// same single-entry caches here, so a window derives the map once per change
// and every surface holds the same object.
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import {
	currentEpochFailure,
	deriveNeedsPerson,
	type NeedsPersonFailure,
	type NeedsPersonMap,
	type NeedsPersonSession,
	sameNeedsPersonMap,
} from "@/lib/agents/needsPerson";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { type AppState, useStore } from "@/store";

type AgentExitFailures = Readonly<Record<string, NeedsPersonFailure>>;

const NO_FAILURES: AgentExitFailures = Object.freeze({});

let failureCache: {
	agents?: AppState["agents"];
	sessions?: Readonly<Record<string, NeedsPersonSession>>;
	value: AgentExitFailures;
} = { value: NO_FAILURES };

/** Store selector: each managed Agent's failure capsule for the current
 * terminal epoch of its Host session. Session metadata changes with every
 * output sequence, so the result keeps its reference until a capsule itself
 * changes, and output alone re-renders nothing. */
export function selectAgentExitFailures(
	state: Pick<AppState, "agents" | "hmuxSessionMetadata">,
): AgentExitFailures {
	if (
		failureCache.agents === state.agents &&
		failureCache.sessions === state.hmuxSessionMetadata
	) {
		return failureCache.value;
	}
	const next: Record<string, NeedsPersonFailure> = {};
	for (const agent of state.agents) {
		const binding = agent.runtimeBinding;
		if (binding?.runtime !== "hmux_managed_v1") continue;
		const failure = currentEpochFailure(
			state.hmuxSessionMetadata[
				hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId)
			],
		);
		if (failure) next[agent.id] = failure;
	}
	const previous = failureCache.value;
	const value = sameFailures(previous, next)
		? previous
		: Object.keys(next).length === 0
			? NO_FAILURES
			: next;
	failureCache = {
		agents: state.agents,
		sessions: state.hmuxSessionMetadata,
		value,
	};
	return value;
}

let mapCache: {
	agents?: AppState["agents"];
	displayStates?: Readonly<Record<string, AgentDisplayState>>;
	waitingSince?: Readonly<Record<string, number>>;
	failures?: AgentExitFailures;
	value: NeedsPersonMap;
} = { value: new Map() };

/** The map for these store values. Equal content keeps the previous map, so
 * memos keyed on it survive unrelated agent edits. */
function needsPersonFor(
	agents: AppState["agents"],
	displayStates: Readonly<Record<string, AgentDisplayState>>,
	waitingSince: Readonly<Record<string, number>>,
	failures: AgentExitFailures,
): NeedsPersonMap {
	if (
		mapCache.agents === agents &&
		mapCache.displayStates === displayStates &&
		mapCache.waitingSince === waitingSince &&
		mapCache.failures === failures
	) {
		return mapCache.value;
	}
	const next = deriveNeedsPerson(agents, { displayStates, waitingSince, failures });
	const value = sameNeedsPersonMap(mapCache.value, next) ? mapCache.value : next;
	mapCache = { agents, displayStates, waitingSince, failures, value };
	return value;
}

/** The map as the stores hold it now, for readers outside React. */
export function readNeedsPerson(): NeedsPersonMap {
	const state = useStore.getState();
	const attention = useAgentAttention.getState();
	return needsPersonFor(
		state.agents,
		attention.displayStates,
		attention.waitingSince,
		selectAgentExitFailures(state),
	);
}

function sameFailures(
	left: AgentExitFailures,
	right: AgentExitFailures,
): boolean {
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every((agentId) => {
			const a = left[agentId];
			const b = right[agentId];
			return (
				b !== undefined &&
				a.sessionId === b.sessionId &&
				a.workspaceId === b.workspaceId &&
				a.terminalEpoch === b.terminalEpoch &&
				a.code === b.code &&
				a.occurredUnixMs === b.occurredUnixMs
			);
		})
	);
}
