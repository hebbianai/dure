import type {
	ManagedRebootRecoveryAssessment,
	ManagedRebootRecoverySkipReason,
} from "@/lib/sessions/managed/managedRebootRecovery";
import type { Agent } from "@/types";

/** Why an Agent was not restored, from assessment or from the attempt. */
export type RestoreAllSkipReason =
	| ManagedRebootRecoverySkipReason
	| "worktree_missing"
	| "state_changed";

export interface RestoreAllAgentEntry {
	identity: string;
	agentId: string;
	name: string;
}

export interface RestoreAllSkippedEntry extends RestoreAllAgentEntry {
	reason: RestoreAllSkipReason;
}

export interface RestoreAllReport {
	restored: readonly RestoreAllAgentEntry[];
	skipped: readonly RestoreAllSkippedEntry[];
	failed: readonly RestoreAllAgentEntry[];
	/** The agents' state could not be read, so nothing was attempted. */
	unavailable?: true;
}

export interface RestoreAllOffer {
	/** Restorable agents in Spaces no window shows; visible ones restore on
	 * their own. */
	restorable: readonly RestoreAllAgentEntry[];
	skipped: readonly RestoreAllSkippedEntry[];
}

export type RestoreAllState =
	| { phase: "idle" }
	| ({ phase: "offer" } & RestoreAllOffer)
	| { phase: "restoring"; total: number; done: number }
	| ({ phase: "report" } & RestoreAllReport);

const IDLE: RestoreAllState = { phase: "idle" };

let state: RestoreAllState = IDLE;
/** Identities the person already answered; a new Host ending offers again. */
const answered = new Set<string>();
const listeners = new Set<() => void>();

function setState(next: RestoreAllState): void {
	state = next;
	for (const listener of listeners) listener();
}

export function agentEntry(
	agents: readonly Agent[],
	identity: string,
	agentId: string,
): RestoreAllAgentEntry {
	const name = agents.find((agent) => agent.id === agentId)?.name.trim();
	return { identity, agentId, name: name || agentId };
}

/** Project one all-Spaces assessment into what the notice offers. */
export function restoreAllOffer(
	assessments: readonly ManagedRebootRecoveryAssessment[],
	visibleDesktopIds: ReadonlySet<string>,
	agents: readonly Agent[],
): RestoreAllOffer {
	const restorable: RestoreAllAgentEntry[] = [];
	const skipped: RestoreAllSkippedEntry[] = [];
	for (const assessment of assessments) {
		if (assessment.outcome === "restorable") {
			const { candidate } = assessment;
			if (!visibleDesktopIds.has(candidate.desktopId)) {
				restorable.push(
					agentEntry(agents, candidate.identity, candidate.agentId),
				);
			}
		} else {
			skipped.push({
				...agentEntry(agents, assessment.identity, assessment.agentId),
				reason: assessment.reason,
			});
		}
	}
	return { restorable, skipped };
}

function entryKey(entry: RestoreAllAgentEntry & { reason?: string }): string {
	return [entry.identity, entry.name, entry.reason ?? ""].join("\0");
}

function sameEntries(
	left: readonly (RestoreAllAgentEntry & { reason?: string })[],
	right: readonly (RestoreAllAgentEntry & { reason?: string })[],
): boolean {
	return (
		left.length === right.length &&
		left.every((entry, index) => {
			const other = right[index];
			return other !== undefined && entryKey(entry) === entryKey(other);
		})
	);
}

/** Offer Restore all while some agent in a background Space can restore and
 * the person has not answered for it yet. A run or its report is never
 * replaced by a newer observation. */
export function publishRestoreAllOffer(offer: RestoreAllOffer): void {
	if (state.phase === "restoring" || state.phase === "report") return;
	const unanswered = offer.restorable.some(
		(entry) => !answered.has(entry.identity),
	);
	if (!unanswered) {
		if (state.phase !== "idle") setState(IDLE);
		return;
	}
	if (
		state.phase === "offer" &&
		sameEntries(state.restorable, offer.restorable) &&
		sameEntries(state.skipped, offer.skipped)
	) {
		return;
	}
	setState({ phase: "offer", ...offer });
}

/** Close the offer or the report; the same agents are not offered again. */
export function dismissRestoreAll(): void {
	if (state.phase === "offer") {
		for (const entry of state.restorable) answered.add(entry.identity);
	} else if (state.phase === "report") {
		for (const entry of [
			...state.restored,
			...state.skipped,
			...state.failed,
		]) {
			answered.add(entry.identity);
		}
	} else {
		return;
	}
	setState(IDLE);
}

/** Offered identities this run answered; an unreadable run gives them back. */
let runIdentities: readonly string[] = [];

/** Claim the run. False when one is already running. */
export function beginRestoreAll(): boolean {
	if (state.phase === "restoring") return false;
	runIdentities =
		state.phase === "offer"
			? state.restorable
					.map((entry) => entry.identity)
					.filter((identity) => !answered.has(identity))
			: [];
	for (const identity of runIdentities) answered.add(identity);
	setState({ phase: "restoring", total: 0, done: 0 });
	return true;
}

export function reportRestoreAllProgress(done: number, total: number): void {
	if (state.phase === "restoring")
		setState({ phase: "restoring", done, total });
}

export function finishRestoreAll(report: RestoreAllReport): void {
	if (report.unavailable) {
		for (const identity of runIdentities) answered.delete(identity);
	}
	runIdentities = [];
	setState({ phase: "report", ...report });
}

export function getRestoreAllState(): RestoreAllState {
	return state;
}

export function subscribeRestoreAll(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function resetRestoreAllForTest(): void {
	state = IDLE;
	runIdentities = [];
	answered.clear();
	listeners.clear();
}
