import { describe, expect, it } from "vitest";
import type { UsageRecentReport } from "@/lib/ipc";
import { accountUsageObservations } from "@/lib/usage/accountUsageObservations";
import type { AccountProfile } from "@/types";

const NOW = 1_800_000_000;

const empty: UsageRecentReport = {
	claude: {} as UsageRecentReport["claude"],
	codex: {} as UsageRecentReport["codex"],
	claudeAccounts: [],
	codexAccounts: [],
	codexAccountSnapshots: [],
};

const codexPool: AccountProfile[] = [
	{ id: "acc-a", provider: "codex", name: "a", dir: "/accounts/codex-a" },
	{ id: "acc-b", provider: "codex", name: "b", dir: "/accounts/codex-b" },
];

describe("accountUsageObservations", () => {
	it("keys Codex readings by credential id and trusts only fresh snapshots", () => {
		const report: UsageRecentReport = {
			...empty,
			codexAccountSnapshots: [
				{
					credentialId: "acc-a",
					capturedAt: NOW - 60,
					attemptedAt: NOW - 60,
					error: null,
					rateLimits: [
						{ limitId: "codex", usedPercent: 42, resetsAt: NOW + 900 } as never,
					],
				},
				{
					credentialId: "acc-b",
					capturedAt: NOW - 45 * 60,
					attemptedAt: NOW - 45 * 60,
					error: null,
					rateLimits: [{ limitId: "codex", usedPercent: 5 } as never],
				},
			],
		};
		expect(accountUsageObservations("codex", report, codexPool, NOW)).toEqual([
			{ credentialId: "acc-a", usedPercent: 42, usedPercentWeekly: null, resetsAtSec: NOW + 900, observedAtSec: NOW - 60 },
			{ credentialId: "acc-b", usedPercent: 5, usedPercentWeekly: null, resetsAtSec: null, observedAtSec: null },
		]);
	});

	it("marks a failed Codex probe as unobserved even when old readings remain", () => {
		const report: UsageRecentReport = {
			...empty,
			codexAccountSnapshots: [
				{
					credentialId: "acc-a",
					capturedAt: NOW - 60,
					attemptedAt: NOW - 10,
					error: "codex_usage_not_signed_in",
					rateLimits: [{ limitId: "codex", usedPercent: 10 } as never],
				},
			],
		};
		expect(accountUsageObservations("codex", report, [codexPool[0]!], NOW)).toEqual([
			{ credentialId: "acc-a", usedPercent: 10, usedPercentWeekly: null, resetsAtSec: null, observedAtSec: null },
		]);
	});

	it("keys Claude readings by the profile directory leaf", () => {
		const pool: AccountProfile[] = [
			{ id: "acc-c", provider: "claude", name: "c", dir: "/Users/x/.dure/accounts/claude-c" },
			{ id: "acc-d", provider: "claude", name: "d", dir: "/Users/x/.dure/accounts/claude-d" },
		];
		const report: UsageRecentReport = {
			...empty,
			claudeAccounts: [
				{
					profileKey: "claude-c",
					usedPercent: 88,
					usedPercentWeekly: 30,
					resetsAt: NOW + 100,
					weeklyResetsAt: NOW + 10_000,
					usedPercentCapturedAt: NOW - 120,
				},
			],
		};
		expect(accountUsageObservations("claude", report, pool, NOW)).toEqual([
			{ credentialId: "acc-c", usedPercent: 88, usedPercentWeekly: 30, resetsAtSec: NOW + 100, observedAtSec: NOW - 120 },
			{ credentialId: "acc-d", usedPercent: null, usedPercentWeekly: null, resetsAtSec: null, observedAtSec: null },
		]);
	});

	it("has nothing to say for providers without account meters", () => {
		expect(accountUsageObservations("gemini", empty, [], NOW)).toEqual([]);
	});
});
