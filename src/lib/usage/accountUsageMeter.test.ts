import { describe, expect, it } from "vitest";
import type { CodexUsageSnapshot } from "@/lib/ipc";
import {
	claudeAccountMeter,
	codexAccountMeter,
	providerAccountMeter,
	supportsProviderAccountMeter,
} from "@/lib/usage/accountUsageMeter";
import type {
	ClaudeAccountRateLimit,
	CodexAccountUsage,
} from "@/lib/usage/usageAccounts";
import type { ProviderUsage } from "@/lib/usage/usageMeter";

const usage = (input: number): ProviderUsage => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: input,
	usedPercent: null,
	usedPercentWeekly: null,
	resetsAt: null,
	weeklyResetsAt: null,
	usedPercentCapturedAt: null,
	rateLimits: [],
});

const codexBucket = (
	credentialId: string | null,
	value: ProviderUsage,
): CodexAccountUsage => ({
	credentialId,
	attributed: true,
	observedOnly: false,
	usage: value,
});

describe("account usage meters", () => {
	const nowSec = 1_000;

	it("selects the observed Claude window and reset for the exact profile", () => {
		const accounts: ClaudeAccountRateLimit[] = [
			{
				profileKey: "claude-work",
				usedPercent: null,
				usedPercentWeekly: 42,
				resetsAt: null,
				weeklyResetsAt: nowSec + 7_200,
				usedPercentCapturedAt: nowSec,
			},
		];
		expect(
			claudeAccountMeter(accounts, "/accounts/claude-work", nowSec),
		).toEqual({ pct: 42, window: "weekly", resetLabel: "2h" });
		expect(claudeAccountMeter([], "/accounts/other", nowSec)).toBeNull();
	});

	it("prefers the exact Codex App Server snapshot over logged limits", () => {
		const snapshots: CodexUsageSnapshot[] = [
			{
				credentialId: "acct-a",
				capturedAt: nowSec,
				attemptedAt: nowSec,
				error: null,
				rateLimits: [
					{
						limitId: "codex",
						limitName: null,
						usedPercent: null,
						usedPercentWeekly: 18,
						resetsAt: null,
						weeklyResetsAt: nowSec + 3 * 86_400,
					},
				],
			},
		];
		const meter = codexAccountMeter(
			[codexBucket("acct-a", { ...usage(10), usedPercent: 77 })],
			snapshots,
			"acct-a",
			nowSec,
		);
		expect(meter).toEqual({ pct: 18, window: "weekly", resetLabel: "3d" });
		expect(codexAccountMeter([], snapshots, "acct-b", nowSec)).toBeNull();
	});

	it("returns no meter when a provider has no usage capability", () => {
		expect(supportsProviderAccountMeter("gemini")).toBe(false);
		expect(
			providerAccountMeter(
				"gemini",
				{
					claude: usage(0),
					codex: usage(0),
					claudeAccounts: [],
					codexAccounts: [],
					codexAccountSnapshots: [],
				},
				undefined,
				undefined,
				nowSec,
			),
		).toBeNull();
	});
});
