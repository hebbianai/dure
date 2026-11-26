import { describe, expect, it } from "vitest";
import type {
	ClaudeUsageSnapshot,
	ClaudeUsageWindow,
	CodexUsageSnapshot,
} from "@/lib/ipc";
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
			claudeAccountMeter(
				accounts,
				undefined,
				"work",
				"/accounts/claude-work",
				nowSec,
			),
		).toEqual({ pct: 42, window: "weekly", resetLabel: "2h", separate: [] });
		expect(
			claudeAccountMeter([], [], "other", "/accounts/other", nowSec),
		).toBeNull();
	});

	const window = (
		id: string,
		kind: ClaudeUsageWindow["kind"],
		usedPercent: number,
		resetsAt: number | null,
		model: string | null = null,
	): ClaudeUsageWindow => ({ id, kind, model, usedPercent, resetsAt });
	const claudeCheck = (
		credentialId: string | null,
		capturedAt: number,
		error: string | null = null,
	): ClaudeUsageSnapshot => ({
		credentialId,
		capturedAt,
		attemptedAt: capturedAt + 5,
		error,
		windows: [
			window("five_hour", "fiveHour", 20, nowSec + 3_600),
			window("seven_day", "weekly", 40, nowSec + 3 * 86_400),
			window("seven_day_fable_5_1", "modelWeekly", 100, nowSec + 93_600, "Fable 5.1"),
			window("seven_day_opus", "modelWeekly", 0, null, "Opus"),
			window("seven_day_sonnet", "modelWeekly", 64, nowSec - 1, "Sonnet"),
			window("seven_day_lantern", "other", 7, nowSec + 2 * 86_400),
		],
	});
	const statusLine = (capturedAt: number): ClaudeAccountRateLimit[] => [
		{
			profileKey: "claude-work",
			usedPercent: 55,
			usedPercentWeekly: 30,
			resetsAt: nowSec + 1_800,
			weeklyResetsAt: nowSec + 86_400,
			usedPercentCapturedAt: capturedAt,
		},
	];
	const fable = {
		limitId: "seven_day_fable_5_1",
		limitName: "Fable 5.1",
		pct: 100,
		window: "weekly",
		resetLabel: "1d 2h",
		weeklyPct: 100,
		weeklyResetLabel: "1d 2h",
	};
	const lantern = {
		limitId: "seven_day_lantern",
		limitName: "seven_day_lantern",
		pct: 7,
		window: null,
		resetLabel: "2d",
		weeklyPct: null,
		weeklyResetLabel: null,
	};

	it("reads a Claude account's check by its ID with each model's own window in use", () => {
		// The check is newer than the statusLine reading, so it gives the
		// general windows. A model window at 0% or one that has reset since
		// the capture is not listed.
		const meter = claudeAccountMeter(
			statusLine(nowSec - 600),
			[claudeCheck("acc-b", nowSec), claudeCheck("acc-a", nowSec - 60)],
			"acc-a",
			"/accounts/claude-work",
			nowSec,
		);
		expect(meter).toEqual({
			pct: 20,
			window: "5h",
			resetLabel: "1h",
			separate: [fable, lantern],
		});
		// An account the check has not read and no statusLine saw has none.
		expect(
			claudeAccountMeter(
				statusLine(nowSec - 600),
				[claudeCheck("acc-b", nowSec)],
				"acc-a",
				"/accounts/other",
				nowSec,
			),
		).toBeNull();
	});

	it("takes a newer statusLine reading for Claude's general windows and keeps the check's model windows", () => {
		const meter = claudeAccountMeter(
			statusLine(nowSec - 10),
			[claudeCheck("acc-a", nowSec - 600, "claude_usage_login_expired")],
			"acc-a",
			"/accounts/claude-work",
			nowSec,
		);
		expect(meter).toEqual({
			pct: 55,
			window: "5h",
			resetLabel: "30m",
			separate: [fable, lantern],
		});
	});

	it("keeps a failed Claude check's last reading when no statusLine reading is newer", () => {
		const meter = claudeAccountMeter(
			undefined,
			[claudeCheck(null, nowSec - 60, "claude_usage_rate_limited")],
			undefined,
			undefined,
			nowSec,
		);
		expect(meter?.pct).toBe(20);
		expect(meter?.separate.map((limit) => limit.limitId)).toEqual([
			"seven_day_fable_5_1",
			"seven_day_lantern",
		]);
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
		expect(meter).toEqual({
			pct: 18,
			window: "weekly",
			resetLabel: "3d",
			separate: [],
		});
		expect(codexAccountMeter([], snapshots, "acct-b", nowSec)).toBeNull();
	});

	it("lists a Codex account's separate model limits in use", () => {
		const bucket = (limitId: string, usedPercent: number) => ({
			limitId,
			limitName: limitId === "codex" ? null : `Model ${limitId}`,
			usedPercent,
			usedPercentWeekly: null,
			resetsAt: nowSec + 600,
			weeklyResetsAt: null,
		});
		const meter = codexAccountMeter(
			[],
			[
				{
					credentialId: "acct-a",
					capturedAt: nowSec,
					attemptedAt: nowSec,
					error: null,
					rateLimits: [bucket("codex", 5), bucket("spark", 12), bucket("idle", 0)],
				},
			],
			"acct-a",
			nowSec,
		);
		expect(meter?.pct).toBe(5);
		expect(meter?.separate).toEqual([
			{
				limitId: "spark",
				limitName: "Model spark",
				pct: 12,
				window: "5h",
				resetLabel: "10m",
				weeklyPct: null,
				weeklyResetLabel: null,
			},
		]);
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
