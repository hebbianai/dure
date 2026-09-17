/** Which account a pane hands off to when its current account hit a usage
 * limit. Pure: the caller supplies the pane's same-provider pool and
 * per-account observed usage; this module never guesses. An account is a
 * target only when its usage was observed recently and every window is
 * below the limit — a stale, unknown, or exhausted account is refused with
 * a typed reason, because a wrong handoff stops a live provider process for
 * nothing. Target selection is one authority: the composer banner, the
 * `handoff` pane action, and the automatic trigger all ask here; whether the
 * move happens by itself is the caller's opt-in, not this module's. */

import { USAGE_OBSERVATION_FRESH_FOR_SECONDS } from "@/lib/usage/codexUsageSnapshots";

export interface AccountUsageObservation {
	readonly credentialId: string;
	/** 0–100 for the short (session) window; null when unread. */
	readonly usedPercent: number | null;
	/** 0–100 for the weekly window; null when unread. */
	readonly usedPercentWeekly: number | null;
	/** Unix seconds when the earliest binding window resets; null unknown. */
	readonly resetsAtSec: number | null;
	/** Unix seconds of the observation; null when never observed. */
	readonly observedAtSec: number | null;
}

export interface UsageLimitHandoffInput {
	readonly currentCredentialId: string | undefined;
	readonly pool: readonly { readonly id: string; readonly name: string }[];
	readonly observations: readonly AccountUsageObservation[];
	readonly nowSec: number;
	/** How old an observation may be and still count as fresh. */
	readonly freshWithinSec?: number;
}

type UsageLimitHandoffRefusalCode =
	| "no_other_account"
	| "usage_unknown"
	| "no_available_account";

export type UsageLimitHandoffDecision =
	| {
			readonly kind: "handoff";
			readonly targetCredentialId: string;
			readonly targetName: string;
			/** The fuller of the target's windows. */
			readonly usedPercent: number;
	  }
	| {
			readonly kind: "refused";
			readonly code: UsageLimitHandoffRefusalCode;
			readonly retryable: boolean;
			readonly nextAction: string;
	  };

/** Same window the usage UI calls fresh; one definition, not two. */
export const DEFAULT_FRESH_WITHIN_SEC = USAGE_OBSERVATION_FRESH_FOR_SECONDS;

function refused(
	code: UsageLimitHandoffRefusalCode,
	retryable: boolean,
	nextAction: string,
): UsageLimitHandoffDecision {
	return { kind: "refused", code, retryable, nextAction };
}

/** The account's headroom is bounded by its fullest window. */
function fullestWindow(observation: AccountUsageObservation): number | null {
	const windows = [observation.usedPercent, observation.usedPercentWeekly].filter(
		(value): value is number => value !== null,
	);
	return windows.length === 0 ? null : Math.max(...windows);
}

/** A limit the provider just reported outranks an older poll: the account
 * reads as exhausted from that moment until its window resets, or for the
 * freshness window when the reset time is unknown. */
export function observationAfterReportedLimit(
	observation: AccountUsageObservation,
	reportedAtSec: number,
): AccountUsageObservation {
	if (observation.observedAtSec !== null && observation.observedAtSec > reportedAtSec) {
		return observation;
	}
	return {
		...observation,
		usedPercent: 100,
		usedPercentWeekly: observation.usedPercentWeekly,
		observedAtSec: reportedAtSec,
	};
}

export function decideUsageLimitHandoff(
	input: UsageLimitHandoffInput,
): UsageLimitHandoffDecision {
	const freshWithinSec = input.freshWithinSec ?? DEFAULT_FRESH_WITHIN_SEC;
	const others = input.pool.filter(
		(account) => account.id !== input.currentCredentialId,
	);
	if (others.length === 0) {
		return refused(
			"no_other_account",
			false,
			"add another account for this provider in Settings › Accounts",
		);
	}
	const byId = new Map(
		input.observations.map((observation) => [observation.credentialId, observation]),
	);
	const fresh = others.flatMap((account) => {
		const observation = byId.get(account.id);
		const usedPercent = observation ? fullestWindow(observation) : null;
		if (
			!observation ||
			observation.observedAtSec === null ||
			usedPercent === null ||
			input.nowSec - observation.observedAtSec > freshWithinSec
		) {
			return [];
		}
		return [{ account, observation, usedPercent }];
	});
	if (fresh.length === 0) {
		return refused(
			"usage_unknown",
			true,
			"no fresh usage reading for the other accounts yet; retry after the next usage poll or switch manually",
		);
	}
	const available = fresh.filter((candidate) => candidate.usedPercent < 100);
	if (available.length === 0) {
		const nextReset = fresh
			.map((candidate) => candidate.observation.resetsAtSec)
			.filter((value): value is number => value !== null)
			.sort((left, right) => left - right)[0];
		return refused(
			"no_available_account",
			true,
			nextReset === undefined
				? "every other account is at its limit; wait for a window to reset"
				: `every other account is at its limit; the earliest window resets at ${new Date(nextReset * 1000).toISOString()}`,
		);
	}
	// Lowest observed usage wins; pool order breaks ties so the choice is
	// deterministic for the same readings.
	const target = available.reduce((best, candidate) =>
		candidate.usedPercent < best.usedPercent ? candidate : best,
	);
	return {
		kind: "handoff",
		targetCredentialId: target.account.id,
		targetName: target.account.name,
		usedPercent: target.usedPercent,
	};
}
