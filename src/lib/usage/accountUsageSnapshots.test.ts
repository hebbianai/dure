import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "@/lib/usage/usageMeter";
import type { ClaudeUsageSnapshot } from "@/lib/ipc";
import {
	applyClaudeSnapshot,
	applyCodexSnapshot,
	claudeCheckIsNewer,
	claudeSeparateMeters,
	accountSnapshotForCredential,
	accountSnapshotFreshness,
} from "./accountUsageSnapshots";

const EMPTY_USAGE: ProviderUsage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	total: 30,
	usedPercent: null,
	usedPercentWeekly: null,
	resetsAt: null,
	weeklyResetsAt: null,
	usedPercentCapturedAt: null,
	rateLimits: [],
};

describe("accountUsageSnapshots", () => {
	it("keeps token accounting while applying the last successful limits", () => {
		const usage = applyCodexSnapshot(EMPTY_USAGE, {
			credentialId: "cx",
			capturedAt: 100,
			attemptedAt: 200,
			error: "codex_usage_unavailable",
			rateLimits: [
				{
					limitId: "codex",
					limitName: null,
					usedPercent: 42,
					usedPercentWeekly: 55,
					resetsAt: 300,
					weeklyResetsAt: 400,
				},
			],
		});
		expect(usage.total).toBe(30);
		expect(usage.usedPercent).toBe(42);
		expect(usage.usedPercentCapturedAt).toBe(100);
		expect(
			accountSnapshotFreshness(
				{
					credentialId: "cx",
					capturedAt: 100,
					attemptedAt: 200,
					error: "codex_usage_unavailable",
				},
				110,
			),
		).toBe("stale");
	});

	it("does not present a logged general limit as part of a model-only snapshot", () => {
		const usage = applyCodexSnapshot(
			{ ...EMPTY_USAGE, usedPercent: 77 },
			{
				credentialId: "cx",
				capturedAt: 100,
				attemptedAt: 100,
				error: null,
				rateLimits: [
					{
						limitId: "codex-model",
						limitName: "Model",
						usedPercent: 12,
						usedPercentWeekly: null,
						resetsAt: 300,
						weeklyResetsAt: null,
					},
				],
			},
		);
		expect(usage.usedPercent).toBeNull();
		expect(usage.rateLimits[0]?.limitId).toBe("codex-model");
	});

	it("matches the implicit default credential without guessing another account", () => {
		const snapshots = [
			{
				credentialId: null,
				capturedAt: 1,
				attemptedAt: 1,
				error: null,
				rateLimits: [],
			},
			{
				credentialId: "cx",
				capturedAt: 2,
				attemptedAt: 2,
				error: null,
				rateLimits: [],
			},
		];
		expect(accountSnapshotForCredential(snapshots, undefined)?.capturedAt).toBe(
			1,
		);
		expect(accountSnapshotForCredential(snapshots, "missing")).toBeUndefined();
	});

	describe("Claude", () => {
		const check = (
			capturedAt: number | null,
			windows: ClaudeUsageSnapshot["windows"],
		): ClaudeUsageSnapshot => ({
			credentialId: "cl",
			capturedAt,
			attemptedAt: capturedAt ?? 50,
			error: capturedAt == null ? "claude_usage_login_expired" : null,
			windows,
		});
		const statusLine: ProviderUsage = {
			...EMPTY_USAGE,
			usedPercent: 70,
			usedPercentWeekly: 50,
			resetsAt: 1_000,
			weeklyResetsAt: 9_000,
			usedPercentCapturedAt: 100,
		};

		it("lays the check's general windows over the statusLine when it is as new or newer", () => {
			const snapshot = check(100, [
				{ id: "five_hour", kind: "fiveHour", model: null, usedPercent: 12, resetsAt: 2_000 },
				// Reset since the capture: no longer current use.
				{ id: "seven_day", kind: "weekly", model: null, usedPercent: 90, resetsAt: 150 },
			]);
			expect(claudeCheckIsNewer(snapshot, 100)).toBe(true);
			const usage = applyClaudeSnapshot(statusLine, snapshot, 200);
			expect(usage).toEqual({
				...statusLine,
				usedPercent: 12,
				resetsAt: 2_000,
				usedPercentWeekly: null,
				weeklyResetsAt: null,
			});
			expect(usage.total).toBe(30);
		});

		it("keeps a newer statusLine reading and a check that never succeeded out", () => {
			const windows: ClaudeUsageSnapshot["windows"] = [
				{ id: "five_hour", kind: "fiveHour", model: null, usedPercent: 1, resetsAt: 2_000 },
			];
			expect(applyClaudeSnapshot(statusLine, check(99, windows), 200)).toBe(
				statusLine,
			);
			expect(applyClaudeSnapshot(statusLine, check(null, windows), 200)).toBe(
				statusLine,
			);
			expect(claudeSeparateMeters(check(null, windows), 200)).toEqual([]);
		});

		it("lists each model's own weekly window, then windows Dure does not know, by name", () => {
			const meters = claudeSeparateMeters(
				check(100, [
					{ id: "five_hour", kind: "fiveHour", model: null, usedPercent: 12, resetsAt: 2_000 },
					{ id: "seven_day_fable_5_1", kind: "modelWeekly", model: "Fable 5.1", usedPercent: 100, resetsAt: 3_800 },
					{ id: "seven_day_opus", kind: "modelWeekly", model: "Opus", usedPercent: 0, resetsAt: null },
					{ id: "seven_day_lantern", kind: "other", model: null, usedPercent: 7, resetsAt: 150 },
				]),
				200,
			);
			expect(meters).toEqual([
				{
					limitId: "seven_day_fable_5_1",
					limitName: "Fable 5.1",
					pct: 100,
					window: "weekly",
					resetLabel: "1h",
					weeklyPct: 100,
					weeklyResetLabel: "1h",
				},
				{
					limitId: "seven_day_opus",
					limitName: "Opus",
					pct: 0,
					window: "weekly",
					resetLabel: null,
					weeklyPct: 0,
					weeklyResetLabel: null,
				},
			]);
		});
	});
});
