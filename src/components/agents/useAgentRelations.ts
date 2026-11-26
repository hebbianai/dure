// The relation forest and its subtree summaries for React surfaces, in two
// passes: the forest follows the Agents' relation facts only, and the
// summaries follow the needs-person map and attention. An attention change
// re-runs the summary pass over the same forest; it never rebuilds it.
import { useMemo, useSyncExternalStore } from "react";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { NeedsPersonMap } from "@/lib/agents/needsPerson";
import { readNeedsPerson } from "@/lib/agents/needsPersonFacts";
import { agentRelationsOf } from "@/lib/agents/relations/agentRelationFacts";
import {
	type AgentRelationSummary,
	type AgentRelations,
	summarizeAgentRelations,
} from "@/lib/agents/relations/agentRelations";
import { type AppState, useStore } from "@/store";

/** Who manages whom among the window's Agents. The store replaces its
 * Agents array on every edit, so the facts are compared only then. */
export function useAgentRelations(): AgentRelations {
	const agents = useStore((state) => state.agents);
	return useMemo(() => agentRelationsOf(agents), [agents]);
}

type Summaries = ReadonlyMap<string, AgentRelationSummary>;

let summaryCache: {
	agents?: AppState["agents"];
	relations?: AgentRelations;
	needsPerson?: NeedsPersonMap;
	displayStates?: Readonly<Record<string, AgentDisplayState>>;
	value: Summaries;
} = { value: new Map() };

function sameSummary(
	left: AgentRelationSummary | undefined,
	right: AgentRelationSummary,
): left is AgentRelationSummary {
	return (
		left !== undefined &&
		left.count === right.count &&
		left.needsPerson === right.needsPerson &&
		left.working === right.working
	);
}

/** Every manager's subtree summary as the stores hold them now. A summary
 * whose numbers did not change keeps its object, so a row re-renders only
 * when its own line changes. */
function readAgentRelationSummaries(): Summaries {
	const { agents } = useStore.getState();
	const needsPerson = readNeedsPerson();
	const { displayStates } = useAgentAttention.getState();
	const sameFacts =
		summaryCache.needsPerson === needsPerson &&
		summaryCache.displayStates === displayStates;
	if (sameFacts && summaryCache.agents === agents) return summaryCache.value;
	const relations = agentRelationsOf(agents);
	let value = summaryCache.value;
	if (!sameFacts || summaryCache.relations !== relations) {
		const previous = summaryCache.value;
		const next = new Map<string, AgentRelationSummary>();
		for (const [agentId, summary] of summarizeAgentRelations(relations, {
			needsPerson,
			displayStates,
		})) {
			const kept = previous.get(agentId);
			next.set(agentId, sameSummary(kept, summary) ? kept : summary);
		}
		value = next;
	}
	summaryCache = { agents, relations, needsPerson, displayStates, value };
	return value;
}

function subscribe(listener: () => void): () => void {
	const stopApp = useStore.subscribe(listener);
	const stopAttention = useAgentAttention.subscribe(listener);
	return () => {
		stopApp();
		stopAttention();
	};
}

/** What one agent manages; absent when it manages none. */
export function useAgentManagedSummary(
	agentId: string,
): AgentRelationSummary | undefined {
	const read = () => readAgentRelationSummaries().get(agentId);
	return useSyncExternalStore(subscribe, read, read);
}
