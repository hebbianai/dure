// One agent row, as every list of agents shows it: Next up today, and the
// Work view, crowded Space cards, a coordinator's team line and the phone
// home as they arrive. This module decides what a row says and in which
// order, as semantic values; each client turns them into its own copy. It
// imports no store, i18n or React, so the phone's build can share it.
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { NeedsPerson } from "@/lib/agents/needsPerson";
import type { AgentRelationSummary } from "@/lib/agents/relations/agentRelations";

/** Why the row is in a list that sorts by attention, as one semantic value. */
export type AgentRowStatus =
	| "approval"
	| "input"
	| "error"
	| "unexpected_exit"
	| "sign_in_exit"
	| "result";

/** The agents a row's agent manages, summed over its whole subtree, as the
 * relation owner counts them. */
export type AgentRowManagedSummary = AgentRelationSummary;

/** The row's one-line activity. It comes only from structured facts: a
 * pending approval the Host projected, a program's own attributed report,
 * or the last prompt from hooks or the Chat timeline. Never terminal text. */
export type AgentRowActivity =
	| { readonly kind: "approval"; readonly toolName: string; readonly summary?: string }
	| { readonly kind: "program"; readonly app?: string; readonly message: string }
	| { readonly kind: "asked"; readonly text: string };

export interface AgentRowFacts {
	readonly agentId: string;
	readonly title: string;
	readonly state?: AgentDisplayState;
	readonly needsPerson?: NeedsPerson;
	/** Whether the agent has a result in the surface's own window. */
	readonly hasResult?: boolean;
	/** When the wait or result began; absent when unseen. */
	readonly sinceMs?: number;
	readonly projectName?: string;
	/** The checkout's branch, from a surface where the project alone does
	 * not say which checkout the agent works in (a Space's status card). */
	readonly branch?: string;
	readonly spaceName?: string;
	/** Titles of the agents above this one, outermost first. */
	readonly path?: readonly string[];
	readonly managed?: AgentRowManagedSummary;
	/** What the pending approval asks, as the Host projected it. */
	readonly approval?: { readonly toolName: string; readonly summary?: string };
	/** The program's own waiting report, for a row the needs-person
	 * authority put here. */
	readonly programNotice?: { readonly app?: string; readonly message?: string };
	/** The last prompt the agent was given. */
	readonly prompt?: string;
}

export interface AgentRowModel {
	readonly agentId: string;
	readonly title: string;
	readonly dot: { readonly state?: AgentDisplayState; readonly unread: boolean };
	readonly status?: AgentRowStatus;
	readonly sinceMs?: number;
	/** Where the agent is, in reading order: project, branch, then Space. */
	readonly context: readonly string[];
	readonly path?: readonly string[];
	readonly managed?: AgentRowManagedSummary;
	readonly activity?: AgentRowActivity;
}

/** Facts that are missing stay missing: no placeholder, no "top level"
 * label, and every agent still gets a row. */
export function agentRowModel(facts: AgentRowFacts): AgentRowModel {
	const status = agentRowStatus(facts.needsPerson, facts.hasResult);
	const context = [facts.projectName, facts.branch, facts.spaceName].filter(
		(value): value is string => Boolean(value),
	);
	const activity = agentRowActivity(facts, status);
	return {
		agentId: facts.agentId,
		title: facts.title,
		// A result nobody has looked at keeps the unread ring.
		dot: { state: facts.state, unread: status === "result" },
		...(status ? { status } : {}),
		...(facts.sinceMs === undefined ? {} : { sinceMs: facts.sinceMs }),
		context,
		...(facts.path && facts.path.length > 0 ? { path: facts.path } : {}),
		...(facts.managed && facts.managed.count > 0 ? { managed: facts.managed } : {}),
		...(activity ? { activity } : {}),
	};
}

export function agentRowStatus(
	needsPerson: NeedsPerson | undefined,
	result: boolean | undefined,
): AgentRowStatus | undefined {
	if (needsPerson?.reason === "unexpected_exit") {
		return needsPerson.signIn ? "sign_in_exit" : "unexpected_exit";
	}
	if (needsPerson) return needsPerson.reason;
	return result ? "result" : undefined;
}

function agentRowActivity(
	facts: AgentRowFacts,
	status: AgentRowStatus | undefined,
): AgentRowActivity | undefined {
	if (status === "approval" && facts.approval) {
		return {
			kind: "approval",
			toolName: facts.approval.toolName,
			...(facts.approval.summary ? { summary: facts.approval.summary } : {}),
		};
	}
	// A program's words only ever add to a wait the authority already found;
	// on a result they are history.
	const message = facts.programNotice?.message;
	if (facts.needsPerson && message) {
		return {
			kind: "program",
			message,
			...(facts.programNotice?.app ? { app: facts.programNotice.app } : {}),
		};
	}
	// One line: a multi-line prompt reads as its words, not its layout.
	const prompt = facts.prompt?.replace(/\s+/g, " ").trim();
	return prompt ? { kind: "asked", text: prompt } : undefined;
}
