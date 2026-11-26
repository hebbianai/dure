// Which agent needs the person next — a presentation over the needs-person
// map and the attention watcher's completion episodes. Membership comes only
// from the needs-person authority and unread results; nothing here is
// persisted or answered, and a program's own status report never puts an
// agent in the list.
import {
	type AttentionEpisodeKind,
	isAgentUnread,
} from "@/lib/agents/agentAttentionStore";
import { compareWaitStart, hasResult } from "@/lib/agents/agentResult";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { NeedsPersonMap, NeedsPersonReason } from "@/lib/agents/needsPerson";

export type NextUpReason = NeedsPersonReason | "result";

export interface NextUpEntry {
	agentId: string;
	reason: NextUpReason;
	/** The agent's display state now, which its row's dot shows. */
	state: AgentDisplayState;
	/** When the reason began. Absent when it began unobserved. */
	sinceMs?: number;
	/** An unexpected exit at the provider's sign-in screen. */
	signIn?: true;
}

export interface NextUp {
	/** Agents only a person can move forward, oldest wait first. */
	needsYou: NextUpEntry[];
	/** Results nobody has looked at yet, oldest first. */
	results: NextUpEntry[];
}

export interface NextUpFacts {
	/** Agents in store order; the tie-break between equal waits. */
	agentIds: readonly string[];
	needsPerson: NeedsPersonMap;
	displayStates: Readonly<Record<string, AgentDisplayState>>;
	episodes: Readonly<Record<string, number>>;
	acks: Readonly<Record<string, number>>;
	episodeKinds: Readonly<Record<string, AttentionEpisodeKind>>;
	episodeAt: Readonly<Record<string, number>>;
}

export function deriveNextUp(facts: NextUpFacts): NextUp {
	const needsYou: NextUpEntry[] = [];
	const results: NextUpEntry[] = [];
	for (const agentId of facts.agentIds) {
		const state = facts.displayStates[agentId];
		const need = facts.needsPerson.get(agentId);
		if (need) {
			needsYou.push({
				agentId,
				reason: need.reason,
				// An exit the watcher has not resolved yet still lists, as the
				// badge counts it.
				state: state ?? "unknown",
				...(need.sinceMs === undefined ? {} : { sinceMs: need.sinceMs }),
				...(need.signIn ? { signIn: true as const } : {}),
			});
			continue;
		}
		if (state === undefined) continue;
		const resultAtMs = facts.episodeAt[agentId];
		if (
			// Next up's window is "not looked at yet": an unread episode in
			// this window, which bringing the agent's pane into view clears.
			hasResult(
				{
					state,
					turnFinished: facts.episodeKinds[agentId] === "done",
					...(resultAtMs === undefined ? {} : { resultAtMs }),
				},
				{ unread: isAgentUnread(facts.episodes, facts.acks, agentId) },
			)
		) {
			results.push({
				agentId,
				reason: "result",
				state,
				...(resultAtMs === undefined ? {} : { sinceMs: resultAtMs }),
			});
		}
	}
	const order = new Map(facts.agentIds.map((agentId, index) => [agentId, index]));
	const byWait = (left: NextUpEntry, right: NextUpEntry) =>
		compareWaitStart(left, right) ||
		(order.get(left.agentId) ?? 0) - (order.get(right.agentId) ?? 0);
	return { needsYou: needsYou.sort(byWait), results: results.sort(byWait) };
}

export function nextUpEntries(nextUp: NextUp): NextUpEntry[] {
	return [...nextUp.needsYou, ...nextUp.results];
}

/** The agent after the one in focus, in list order, wrapping around. A
 * focused agent outside the list starts from the top. */
export function nextUpTarget(
	entries: readonly NextUpEntry[],
	focusedAgentId: string | undefined,
): NextUpEntry | undefined {
	if (entries.length === 0) return undefined;
	const index = entries.findIndex((item) => item.agentId === focusedAgentId);
	return entries[(index + 1) % entries.length];
}
