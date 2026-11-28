// The relation forest and its subtree summaries for React surfaces, in two
// passes: the forest follows the relation facts only (agentRelationFacts.ts),
// and the summaries follow the needs-person map and attention. An attention
// change re-runs the summary pass over the same forest; it never rebuilds it.
import { useMemo, useSyncExternalStore } from "react";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { NeedsPersonMap } from "@/lib/agents/needsPerson";
import { readNeedsPerson } from "@/lib/agents/needsPersonFacts";
import {
	type AgentRelationFacts,
	agentRelationFactsOf,
	agentRelationsOf,
} from "@/lib/agents/relations/agentRelationFacts";
import {
	type AgentRelationSummary,
	type AgentRelations,
	summarizeAgentRelations,
} from "@/lib/agents/relations/agentRelations";
import { shellRelationNodesOf } from "@/lib/agents/relations/shellRelationNodes";
import { useStore } from "@/store";

/** Who manages whom among the window's Agents and plain shell rows. The
 * store replaces its Agents array on every edit, and the shells keep theirs
 * until one changes, so the facts are compared only then. */
export function useAgentRelations(): AgentRelations {
	const agents = useStore((state) => state.agents);
	const shells = useStore(shellRelationNodesOf);
	return useMemo(() => agentRelationsOf({ agents, shells }), [agents, shells]);
}

type Summaries = ReadonlyMap<string, AgentRelationSummary>;

let summaryCache: {
	facts?: AgentRelationFacts;
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
	const facts = agentRelationFactsOf(useStore.getState());
	const needsPerson = readNeedsPerson();
	const { displayStates } = useAgentAttention.getState();
	const sameFacts =
		summaryCache.needsPerson === needsPerson &&
		summaryCache.displayStates === displayStates;
	if (
		sameFacts &&
		summaryCache.facts?.agents === facts.agents &&
		summaryCache.facts.shells === facts.shells
	) {
		return summaryCache.value;
	}
	const relations = agentRelationsOf(facts);
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
	summaryCache = { facts, relations, needsPerson, displayStates, value };
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
