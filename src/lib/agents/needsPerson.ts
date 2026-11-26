// Which agents only a person can move forward, and why — the ONE authority.
// The rail badge, Next up, the Dock badge and the Spaces rollups all read the
// map this module derives; a second inline rule would let them disagree.
//
// "Needs a person" is limited to what only a person can resolve: an approval,
// an answer, an error, or a provider that exited on its own. Nothing here is
// persisted, answered or acknowledged. The module imports no store, i18n or
// React, so the phone's build can share it.
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";

export type NeedsPersonReason = "approval" | "input" | "error" | "unexpected_exit";

export interface NeedsPerson {
	readonly reason: NeedsPersonReason;
	/** When the wait began: the Host's exit time for an unexpected exit,
	 * otherwise when this window saw it begin. Absent when it began unseen. */
	readonly sinceMs?: number;
	/** An unexpected exit at the provider's sign-in screen: signing in again
	 * is what the person can do. */
	readonly signIn?: true;
}

/** Agent id → why a person is needed. Agents that need no one are absent. */
export type NeedsPersonMap = ReadonlyMap<string, NeedsPerson>;

/** Display states that require a person (error · blocked · input). */
export const NEEDS_PERSON_DISPLAY_STATES: ReadonlySet<string> = new Set([
	"error",
	"blocked",
	"input",
]);

/** Every display state that needs a person, named for the person. Covering
 * NEEDS_PERSON_DISPLAY_STATES exactly is a tested contract. */
export const NEEDS_PERSON_REASON_BY_STATE: Readonly<
	Partial<Record<AgentDisplayState, Exclude<NeedsPersonReason, "unexpected_exit">>>
> = { blocked: "approval", input: "input", error: "error" };

/** The runtime's typed cause for a managed provider that exited at its
 * sign-in screen. Copy keys on this code, never on the summary prose. */
const PROVIDER_EXITED_AT_SIGN_IN = "provider_exited_at_sign_in";

/** The Host's failure capsule: written only when a managed provider exited
 * on its own, never for a stop a person or the Host asked for. */
export interface NeedsPersonFailure {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly terminalEpoch: string;
	readonly code: string;
	/** Unix milliseconds, as the Host's decimal string. */
	readonly occurredUnixMs?: string;
}

/** A Host session as the census reports it: its current terminal epoch and
 * the failure capsule it keeps, if any. */
export interface NeedsPersonSession {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly terminalEpoch: string;
	readonly failure?: NeedsPersonFailure;
}

/** The failure capsule of this session's current terminal epoch. A capsule
 * left from an earlier epoch describes a process that has since been
 * replaced, so it says nothing about the agent now. */
export function currentEpochFailure(
	session: NeedsPersonSession | undefined,
): NeedsPersonFailure | undefined {
	const failure = session?.failure;
	return failure &&
		failure.sessionId === session.sessionId &&
		failure.workspaceId === session.workspaceId &&
		failure.terminalEpoch === session.terminalEpoch
		? failure
		: undefined;
}

export interface NeedsPersonInput {
	readonly displayState?: string;
	/** The failure capsule of the agent's current terminal epoch, already
	 * matched by `currentEpochFailure`. */
	readonly failure?: NeedsPersonFailure;
	/** When this window saw a wait for a person begin. */
	readonly waitingSinceMs?: number;
}

/** Why a person is needed, if one is. An exit capsule for the current epoch
 * wins over the display state: the provider process it describes is gone,
 * so an approval or question it showed can no longer be answered. Any exit
 * kind counts, a clean exit code included: the Host writes no capsule for a
 * stop someone asked for. */
export function needsPersonOf(input: NeedsPersonInput): NeedsPerson | undefined {
	if (input.failure) {
		const sinceMs = unixMs(input.failure.occurredUnixMs);
		return {
			reason: "unexpected_exit",
			...(sinceMs === undefined ? {} : { sinceMs }),
			...(input.failure.code === PROVIDER_EXITED_AT_SIGN_IN
				? { signIn: true as const }
				: {}),
		};
	}
	const reason =
		input.displayState !== undefined &&
		NEEDS_PERSON_DISPLAY_STATES.has(input.displayState)
			? NEEDS_PERSON_REASON_BY_STATE[input.displayState as AgentDisplayState]
			: undefined;
	if (!reason) return undefined;
	return input.waitingSinceMs === undefined
		? { reason }
		: { reason, sinceMs: input.waitingSinceMs };
}

export function needsPersonReason(
	input: NeedsPersonInput,
): NeedsPersonReason | undefined {
	return needsPersonOf(input)?.reason;
}

export interface NeedsPersonFacts {
	readonly displayStates: Readonly<Record<string, AgentDisplayState | undefined>>;
	readonly waitingSince: Readonly<Record<string, number | undefined>>;
	/** Agent id → its current-epoch failure capsule. */
	readonly failures: Readonly<Record<string, NeedsPersonFailure | undefined>>;
}

/** The needs-person map over the registered agents. Agents with no fact are
 * simply absent: missing facts never flag or exclude anyone. */
export function deriveNeedsPerson(
	agents: readonly { readonly id: string }[],
	facts: NeedsPersonFacts,
): NeedsPersonMap {
	const map = new Map<string, NeedsPerson>();
	for (const { id } of agents) {
		const need = needsPersonOf({
			displayState: facts.displayStates[id],
			failure: facts.failures[id],
			waitingSinceMs: facts.waitingSince[id],
		});
		if (need) map.set(id, need);
	}
	return map;
}

export function sameNeedsPersonMap(left: NeedsPersonMap, right: NeedsPersonMap): boolean {
	if (left === right) return true;
	if (left.size !== right.size) return false;
	for (const [agentId, need] of left) {
		const other = right.get(agentId);
		if (
			!other ||
			other.reason !== need.reason ||
			other.sinceMs !== need.sinceMs ||
			other.signIn !== need.signIn
		) {
			return false;
		}
	}
	return true;
}

function unixMs(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const ms = Number(value);
	return Number.isSafeInteger(ms) ? ms : undefined;
}
