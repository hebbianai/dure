/** Shared account selection for automatic and explicit usage-limit handoffs.
 * Prefer fresh available readings, then try unobserved configured accounts.
 * Missing telemetry is not a provider failure; actual reported limits exclude
 * the account while that observation remains fresh. */

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

type UsageLimitHandoffRefusalCode = "no_other_account" | "no_available_account";

export type UsageLimitHandoffDecision =
	| {
			readonly kind: "handoff";
			readonly targetCredentialId: string;
			readonly targetName: string;
			/** The fuller observed window, or null when no fresh reading exists. */
			readonly usedPercent: number | null;
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
	const windows = [
		observation.usedPercent,
		observation.usedPercentWeekly,
	].filter((value): value is number => value !== null);
	return windows.length === 0 ? null : Math.max(...windows);
}

/** A limit the provider just reported outranks an older poll: the account
 * reads as exhausted from that moment until its window resets, or for the
 * freshness window when the reset time is unknown. */
export function observationAfterReportedLimit(
	observation: AccountUsageObservation,
	reportedAtSec: number,
): AccountUsageObservation {
	if (
		observation.observedAtSec !== null &&
		observation.observedAtSec > reportedAtSec
	) {
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
		input.observations.map((observation) => [
			observation.credentialId,
			observation,
		]),
	);
	const candidates = others.map((account) => {
		const observation = byId.get(account.id);
		const fresh =
			observation?.observedAtSec != null &&
			input.nowSec - observation.observedAtSec <= freshWithinSec;
		const usedPercent = fresh ? fullestWindow(observation) : null;
		return { account, observation, usedPercent };
	});
	const available = candidates.filter(
		(candidate) =>
			candidate.usedPercent === null || candidate.usedPercent < 100,
	);
	if (available.length === 0) {
		const nextReset = candidates
			.map((candidate) => candidate.observation?.resetsAtSec ?? null)
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
	// Fresh available readings rank first; unknown usage and ties use pool order.
	const target = available.reduce((best, candidate) =>
		(candidate.usedPercent ?? Infinity) < (best.usedPercent ?? Infinity)
			? candidate
			: best,
	);
	return {
		kind: "handoff",
		targetCredentialId: target.account.id,
		targetName: target.account.name,
		usedPercent: target.usedPercent,
	};
}
