// Which agent needs the person next — a presentation over the needs-person
// map and the attention watcher's completion episodes. Membership comes only
// from the needs-person authority and unread results; nothing here is
// persisted or answered, and a program's own status report never puts an
// agent in the list.
import {
	type AttentionEpisodeKind,
	isAgentUnread,
} from "@/lib/agents/agentAttentionStore";
import {
	type AgentResultWindow,
	compareWaitStart,
	hasResult,
} from "@/lib/agents/agentResult";
import type { AgentRowFacts } from "@/lib/agents/agentRowModel";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type {
	NeedsPerson,
	NeedsPersonMap,
	NeedsPersonReason,
} from "@/lib/agents/needsPerson";

type NextUpReason = NeedsPersonReason | "result";

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

/** One agent's attention facts, as the needs-person map and the attention
 * watcher hold them. */
export interface NextUpAgentFacts {
	readonly needsPerson: NeedsPerson | undefined;
	readonly state: AgentDisplayState | undefined;
	/** The latest episode was a finished turn. */
	readonly turnFinished: boolean;
	readonly resultAtMs?: number;
	/** The latest episode has not been looked at in this window. */
	readonly unread: boolean;
}

export function nextUpAgentFacts(
	facts: Omit<NextUpFacts, "agentIds">,
	agentId: string,
): NextUpAgentFacts {
	const resultAtMs = facts.episodeAt[agentId];
	return {
		needsPerson: facts.needsPerson.get(agentId),
		state: facts.displayStates[agentId],
		turnFinished: facts.episodeKinds[agentId] === "done",
		...(resultAtMs === undefined ? {} : { resultAtMs }),
		unread: isAgentUnread(facts.episodes, facts.acks, agentId),
	};
}

/** Why one agent is in Next up, if it is. Any surface that reports an agent
 * the way Next up does (a crowded pane's status card, the Work view) reads
 * this. Next up's own result window is "not looked at yet"; a surface with
 * another window (the Work view's local day) passes it. */
export function nextUpEntry(
	agentId: string,
	facts: NextUpAgentFacts,
	window: AgentResultWindow = { unread: facts.unread },
): NextUpEntry | undefined {
	const { needsPerson: need, state, resultAtMs } = facts;
	if (need) {
		return {
			agentId,
			reason: need.reason,
			// An exit the watcher has not resolved yet still lists, as the
			// badge counts it.
			state: state ?? "unknown",
			...(need.sinceMs === undefined ? {} : { sinceMs: need.sinceMs }),
			...(need.signIn ? { signIn: true as const } : {}),
		};
	}
	if (state === undefined) return undefined;
	// Next up's window is "not looked at yet": an unread episode in this
	// window, which bringing the agent's pane into view clears.
	return hasResult(
		{
			state,
			turnFinished: facts.turnFinished,
			...(resultAtMs === undefined ? {} : { resultAtMs }),
		},
		window,
	)
		? {
				agentId,
				reason: "result",
				state,
				...(resultAtMs === undefined ? {} : { sinceMs: resultAtMs }),
			}
		: undefined;
}

/** `resultsSinceMs` lists results since that moment instead of the ones not
 * looked at yet; the needs-you half is the same either way. */
export function deriveNextUp(
	facts: NextUpFacts,
	resultsSinceMs?: number,
): NextUp {
	const needsYou: NextUpEntry[] = [];
	const results: NextUpEntry[] = [];
	for (const agentId of facts.agentIds) {
		const agentFacts = nextUpAgentFacts(facts, agentId);
		const entry = nextUpEntry(
			agentId,
			agentFacts,
			resultsSinceMs === undefined ? undefined : { sinceMs: resultsSinceMs },
		);
		if (entry) (entry.reason === "result" ? results : needsYou).push(entry);
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

/** Where a Next up entry stands, for its row: why it is listed and since
 * when, in the needs-person and has-result vocabulary every row shares. */
export function nextUpRowPlacement(
	entry: NextUpEntry,
): Pick<AgentRowFacts, "state" | "needsPerson" | "hasResult" | "sinceMs"> {
	return {
		state: entry.state,
		...(entry.reason === "result"
			? { hasResult: true }
			: {
					needsPerson: {
						reason: entry.reason,
						...(entry.signIn ? { signIn: entry.signIn } : {}),
					},
				}),
		...(entry.sinceMs === undefined ? {} : { sinceMs: entry.sinceMs }),
	};
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
