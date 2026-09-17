import { describe, expect, it } from "vitest";
import {
	type AccountUsageObservation,
	decideUsageLimitHandoff,
	observationAfterReportedLimit,
} from "./usageLimitHandoffPolicy";

const NOW = 1_800_000_000;
const pool = [
	{ id: "acc-a", name: "personal" },
	{ id: "acc-b", name: "work" },
	{ id: "acc-c", name: "spare" },
];

function seen(
	credentialId: string,
	usedPercent: number | null,
	ageSec = 60,
	resetsAtSec: number | null = NOW + 3600,
	usedPercentWeekly: number | null = null,
): AccountUsageObservation {
	return {
		credentialId,
		usedPercent,
		usedPercentWeekly,
		resetsAtSec,
		observedAtSec: NOW - ageSec,
	};
}

function decide(overrides: Partial<Parameters<typeof decideUsageLimitHandoff>[0]> = {}) {
	return decideUsageLimitHandoff({
		currentCredentialId: "acc-a",
		pool,
		observations: [seen("acc-a", 100), seen("acc-b", 40), seen("acc-c", 10)],
		nowSec: NOW,
		...overrides,
	});
}

describe("decideUsageLimitHandoff", () => {
	it("hands off to the freshest-observed account with the lowest usage", () => {
		expect(decide()).toEqual({
			kind: "handoff",
			targetCredentialId: "acc-c",
			targetName: "spare",
			usedPercent: 10,
		});
	});

	it("never picks the current account, even when it reads lower", () => {
		expect(
			decide({ observations: [seen("acc-a", 0), seen("acc-b", 60), seen("acc-c", 70)] }),
		).toMatchObject({ kind: "handoff", targetCredentialId: "acc-b" });
	});

	it("counts an account as exhausted when any window is full and ranks by the fullest", () => {
		// b: session 20% but weekly 100% → exhausted; c: session 60%, weekly 70% → 70.
		expect(
			decide({
				observations: [
					seen("acc-b", 20, 60, NOW + 3600, 100),
					seen("acc-c", 60, 60, NOW + 3600, 70),
				],
			}),
		).toEqual({
			kind: "handoff",
			targetCredentialId: "acc-c",
			targetName: "spare",
			usedPercent: 70,
		});
		// A weekly-only reading still counts.
		expect(
			decide({ observations: [seen("acc-b", null, 60, null, 30)] }),
		).toMatchObject({ kind: "handoff", targetCredentialId: "acc-b", usedPercent: 30 });
	});

	it("refuses when there is no other account", () => {
		expect(decide({ pool: [pool[0]!] })).toMatchObject({
			kind: "refused",
			code: "no_other_account",
			retryable: false,
		});
	});

	it("tries configured accounts with unknown usage, preferring fresh available readings", () => {
		expect(
			decide({
				observations: [seen("acc-b", 5, 40 * 60), seen("acc-c", null)],
			}),
		).toMatchObject({ kind: "handoff", targetCredentialId: "acc-b", usedPercent: null });
		expect(decide({ observations: [] })).toMatchObject({ kind: "handoff", targetCredentialId: "acc-b", usedPercent: null });
		// A stale low reading loses to a fresh higher one.
		expect(
			decide({ observations: [seen("acc-b", 5, 40 * 60), seen("acc-c", 80)] }),
		).toMatchObject({ kind: "handoff", targetCredentialId: "acc-c" });
	});

	it("tries an unobserved account after excluding a provider-reported limit", () => {
		expect(decide({ observations: [
			observationAfterReportedLimit(seen("acc-b", 10), NOW - 10),
		] })).toMatchObject({ kind: "handoff", targetCredentialId: "acc-c", usedPercent: null });
	});

	it("refuses when every fresh account is exhausted and names the earliest reset", () => {
		const decision = decide({
			observations: [
				seen("acc-b", 100, 60, NOW + 7200),
				seen("acc-c", 100, 60, NOW + 600),
			],
		});
		expect(decision).toMatchObject({
			kind: "refused",
			code: "no_available_account",
			retryable: true,
		});
		expect(decision.kind === "refused" && decision.nextAction).toContain(
			new Date((NOW + 600) * 1000).toISOString(),
		);
	});

	it("breaks ties by pool order so the same readings give the same answer", () => {
		expect(
			decide({ observations: [seen("acc-b", 30), seen("acc-c", 30)] }),
		).toMatchObject({ targetCredentialId: "acc-b" });
	});
});

describe("observationAfterReportedLimit", () => {
	it("makes a provider-reported limit outrank an older poll, but not a newer one", () => {
		const polled = seen("acc-a", 40, 10 * 60);
		expect(observationAfterReportedLimit(polled, NOW - 60)).toMatchObject({
			usedPercent: 100,
			observedAtSec: NOW - 60,
		});
		const newer = seen("acc-a", 5, 10);
		expect(observationAfterReportedLimit(newer, NOW - 60)).toBe(newer);
	});

	it("keeps an account that just hit its limit out of the candidates", () => {
		// The pane moved a→b, b just failed; a's 30-minute-old poll still says 97%.
		const observations = [
			observationAfterReportedLimit(seen("acc-a", 97, 25 * 60), NOW - 20 * 60),
			seen("acc-b", 30),
			seen("acc-c", 50),
		];
		expect(
			decideUsageLimitHandoff({ currentCredentialId: "acc-b", pool, observations, nowSec: NOW }),
		).toMatchObject({ kind: "handoff", targetCredentialId: "acc-c" });
	});
});
