// Whether an agent "has a result" — the one predicate every surface uses.
// A finished turn is all Dure knows, so the honest word is "has a result",
// never "done". Each surface picks its own window and documents it where it
// passes one; nothing here is persisted or acknowledged. The module imports
// no store, i18n or React, so the phone's build can share it.
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";

export interface AgentResultFacts {
	/** The agent's display state now. */
	readonly state: AgentDisplayState | undefined;
	/** The latest thing the agent did was finish a turn, rather than stop to
	 * wait for a person. */
	readonly turnFinished: boolean;
	/** When the turn was seen finishing; absent when it finished unseen. */
	readonly resultAtMs?: number;
}

/** Which results a surface lists: the ones nobody has looked at in this
 * window yet, or the ones that finished since a moment the surface chooses
 * (for example the start of the local day, or 24 hours ago). */
export type AgentResultWindow =
	| { readonly unread: boolean }
	| { readonly sinceMs: number };

export function hasResult(
	facts: AgentResultFacts,
	window: AgentResultWindow,
): boolean {
	// Once work resumes, the result the turn produced is no longer the latest.
	// An agent that went unobserved or exited still has one.
	if (!facts.turnFinished || facts.state === "working") return false;
	if ("unread" in window) return window.unread;
	return facts.resultAtMs !== undefined && facts.resultAtMs >= window.sinceMs;
}

/** Oldest wait or result first. A start nobody saw predates everything
 * that was seen; equal starts keep the caller's order. */
export function compareWaitStart(
	left: { readonly sinceMs?: number },
	right: { readonly sinceMs?: number },
): number {
	if (left.sinceMs === undefined) return right.sinceMs === undefined ? 0 : -1;
	if (right.sinceMs === undefined) return 1;
	return left.sinceMs - right.sinceMs;
}
