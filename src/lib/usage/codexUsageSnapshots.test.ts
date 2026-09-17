import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "@/lib/usage/usageMeter";
import type { AccountProfile } from "@/types";
import {
	applyCodexSnapshot,
	codexSnapshotForCredential,
	codexSnapshotFreshness,
	codexUsageProfiles,
} from "./codexUsageSnapshots";

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

describe("codexUsageSnapshots", () => {
	it("includes default and only registered Codex profiles", () => {
		const accounts: AccountProfile[] = [
			{ id: "cx", name: "Codex", provider: "codex", dir: "/profiles/cx" },
			{ id: "cl", name: "Claude", provider: "claude", dir: "/profiles/cl" },
		];
		expect(codexUsageProfiles(accounts)).toEqual([
			{ credentialId: null, directory: null },
			{ credentialId: "cx", directory: "/profiles/cx" },
		]);
	});

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
			codexSnapshotFreshness(
				{
					credentialId: "cx",
					capturedAt: 100,
					attemptedAt: 200,
					error: "codex_usage_unavailable",
					rateLimits: [],
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
		expect(codexSnapshotForCredential(snapshots, undefined)?.capturedAt).toBe(
			1,
		);
		expect(codexSnapshotForCredential(snapshots, "missing")).toBeUndefined();
	});
});
