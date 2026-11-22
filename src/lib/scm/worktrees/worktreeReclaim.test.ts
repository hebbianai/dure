import { describe, expect, it } from "vitest";
import {
	isLowDiskSpace,
	keptWorktrees,
	parseVolumeSpaces,
	parseWorktreeReclaimOutcomes,
	parseWorktreeReclaimScan,
	removableBytes,
	removableWorktrees,
	summarizeWorktreeReclaim,
	worktreeDisplayPath,
} from "@/lib/scm/worktrees/worktreeReclaim";

const GIB = 1024 ** 3;

function instance(name: string) {
	return {
		schemaVersion: 1 as const,
		canonicalPath: `/work/app/.worktrees/${name}`,
		gitCommonDir: "/work/app/.git",
		gitDir: `/work/app/.git/worktrees/${name}`,
		instanceToken: `dwt1_${name.padEnd(32, "0").slice(0, 32).replace(/[^0-9a-f]/g, "a")}`,
	};
}

const SCAN = {
	repositoryPath: "/work/app",
	checkouts: [
		{ instance: instance("a"), branch: "run-a", hold: null, sizeBytes: 300 },
		{ instance: instance("b"), branch: null, hold: null, sizeBytes: 200 },
		{ instance: instance("c"), branch: "run-c", hold: "dirty", sizeBytes: null },
		{ instance: instance("d"), branch: "run-d", hold: "in_use", sizeBytes: null },
	],
};

describe("worktree reclaim scan", () => {
	it("splits what may go from what is kept, with the total it frees", () => {
		const scan = parseWorktreeReclaimScan(SCAN);
		expect(removableWorktrees(scan).map((checkout) => checkout.branch)).toEqual([
			"run-a",
			null,
		]);
		expect(keptWorktrees(scan).map((checkout) => checkout.hold)).toEqual([
			"dirty",
			"in_use",
		]);
		expect(removableBytes(scan)).toBe(500);
	});

	it("refuses a malformed backend answer instead of guessing", () => {
		expect(() =>
			parseWorktreeReclaimScan({
				...SCAN,
				checkouts: [{ ...SCAN.checkouts[0], hold: "maybe" }],
			}),
		).toThrow();
		expect(() =>
			parseWorktreeReclaimScan({
				...SCAN,
				checkouts: [{ ...SCAN.checkouts[0], instance: { canonicalPath: "/x" } }],
			}),
		).toThrow();
		expect(() => parseWorktreeReclaimScan(null)).toThrow();
	});

	it("names a worktree by its path under the repository", () => {
		const [first] = parseWorktreeReclaimScan(SCAN).checkouts;
		expect(worktreeDisplayPath("/work/app", first)).toBe(".worktrees/a");
		expect(worktreeDisplayPath("/work/app/", first)).toBe(".worktrees/a");
		expect(worktreeDisplayPath("/work/ap", first)).toBe(first.instance.canonicalPath);
	});
});

describe("worktree reclaim outcomes", () => {
	it("totals what was freed and keeps each refusal with its worktree", () => {
		const requested = [instance("a"), instance("b"), instance("c")];
		const outcomes = parseWorktreeReclaimOutcomes(
			[
				{ outcome: "removed", freedBytes: 300 },
				{ outcome: "kept", hold: "in_use" },
				{ outcome: "failed", code: "worktree_remove_failed", message: "busy" },
			],
			requested.length,
		);
		expect(summarizeWorktreeReclaim(requested, outcomes)).toEqual({
			removed: 1,
			freedBytes: 300,
			kept: [{ instance: requested[1], hold: "in_use" }],
			failed: [{ instance: requested[2], message: "busy" }],
		});
	});

	it("requires exactly one outcome per requested worktree", () => {
		expect(() =>
			parseWorktreeReclaimOutcomes([{ outcome: "removed", freedBytes: 1 }], 2),
		).toThrow();
	});
});

describe("low disk space", () => {
	it("is under 20 GiB free, or under a tenth of a small disk", () => {
		expect(isLowDiskSpace({ freeBytes: 19 * GIB, totalBytes: 1000 * GIB })).toBe(true);
		expect(isLowDiskSpace({ freeBytes: 21 * GIB, totalBytes: 1000 * GIB })).toBe(false);
		// 128 GiB disk: the line is 12.8 GiB.
		expect(isLowDiskSpace({ freeBytes: 12 * GIB, totalBytes: 128 * GIB })).toBe(true);
		expect(isLowDiskSpace({ freeBytes: 13 * GIB, totalBytes: 128 * GIB })).toBe(false);
	});

	it("never calls an unmeasured disk low", () => {
		expect(isLowDiskSpace(null)).toBe(false);
		expect(isLowDiskSpace({ freeBytes: 0, totalBytes: 0 })).toBe(false);
	});

	it("parses one answer per requested path", () => {
		expect(
			parseVolumeSpaces([{ freeBytes: 1, totalBytes: 2 }, null], 2),
		).toEqual([{ freeBytes: 1, totalBytes: 2 }, null]);
		expect(() => parseVolumeSpaces([null], 2)).toThrow();
		expect(() => parseVolumeSpaces([{ freeBytes: -1, totalBytes: 2 }], 1)).toThrow();
	});
});
