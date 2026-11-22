import { afterEach, describe, expect, it, vi } from "vitest";

const scanReclaimableWorktrees = vi.fn();
const reclaimWorktrees = vi.fn();
vi.mock("@/lib/ipc", () => ({
	scanReclaimableWorktrees: (path: string) => scanReclaimableWorktrees(path),
	reclaimWorktrees: (path: string, instances: unknown[]) =>
		reclaimWorktrees(path, instances),
}));

import {
	dismissLowDiskNotice,
	getWorktreeReclaimState,
	lowDiskOffer,
	reclaimProjectWorktrees,
	resetWorktreeReclaimStoreForTest,
	scanProjectWorktrees,
	setLowDiskSpace,
} from "@/lib/scm/worktrees/worktreeReclaimStore";

function instance(name: string) {
	return {
		schemaVersion: 1 as const,
		canonicalPath: `/work/app/.worktrees/${name}`,
		gitCommonDir: "/work/app/.git",
		gitDir: `/work/app/.git/worktrees/${name}`,
		instanceToken: `dwt1_${"a".repeat(31)}${name}`,
	};
}

const clean = { instance: instance("1"), branch: "run-1", hold: null, sizeBytes: 300 };
const other = { instance: instance("2"), branch: "run-2", hold: null, sizeBytes: 200 };
const dirty = { instance: instance("3"), branch: "run-3", hold: "dirty", sizeBytes: null };

function scanOf(...checkouts: unknown[]) {
	return { repositoryPath: "/work/app", checkouts };
}

afterEach(() => {
	resetWorktreeReclaimStoreForTest();
	scanReclaimableWorktrees.mockReset();
	reclaimWorktrees.mockReset();
});

describe("worktree reclaim store", () => {
	it("keeps one scan per project in flight", async () => {
		scanReclaimableWorktrees.mockResolvedValue(scanOf(clean));
		await Promise.all([
			scanProjectWorktrees("/work/app"),
			scanProjectWorktrees("/work/app"),
		]);
		expect(scanReclaimableWorktrees).toHaveBeenCalledTimes(1);
		expect(getWorktreeReclaimState().projects["/work/app"]).toMatchObject({
			status: "ready",
			scan: scanOf(clean),
		});
	});

	it("removes exactly what the scan offered, reports it and looks again", async () => {
		scanReclaimableWorktrees.mockResolvedValueOnce(scanOf(clean, other, dirty));
		await scanProjectWorktrees("/work/app");
		reclaimWorktrees.mockResolvedValue([
			{ outcome: "removed", freedBytes: 300 },
			{ outcome: "kept", hold: "in_use" },
		]);
		scanReclaimableWorktrees.mockResolvedValueOnce(scanOf({ ...other, hold: "in_use" }, dirty));

		await reclaimProjectWorktrees("/work/app");

		expect(reclaimWorktrees).toHaveBeenCalledWith("/work/app", [
			clean.instance,
			other.instance,
		]);
		expect(getWorktreeReclaimState().projects["/work/app"]).toMatchObject({
			status: "ready",
			summary: {
				removed: 1,
				freedBytes: 300,
				kept: [{ instance: other.instance, hold: "in_use" }],
				failed: [],
			},
		});
	});

	it("shows a failed scan without losing the last list", async () => {
		scanReclaimableWorktrees.mockResolvedValueOnce(scanOf(clean));
		await scanProjectWorktrees("/work/app");
		scanReclaimableWorktrees.mockRejectedValueOnce(new Error("git failed"));
		await scanProjectWorktrees("/work/app");
		expect(getWorktreeReclaimState().projects["/work/app"]).toEqual({
			status: "error",
			message: "git failed",
			scan: scanOf(clean),
		});
	});
});

describe("low disk offer", () => {
	it("offers only removable worktrees in projects on the low volume", async () => {
		scanReclaimableWorktrees.mockImplementation(async (path: string) =>
			path === "/work/app" ? scanOf(clean, other, dirty) : scanOf(clean),
		);
		await scanProjectWorktrees("/work/app");
		await scanProjectWorktrees("/elsewhere");
		setLowDiskSpace({ projectPaths: ["/work/app"], freeBytes: 1024 });
		expect(lowDiskOffer(getWorktreeReclaimState())).toEqual({
			freeBytes: 1024,
			projectPaths: ["/work/app"],
			count: 2,
			bytes: 500,
		});
	});

	it("says nothing when there is nothing to remove or it was dismissed", async () => {
		scanReclaimableWorktrees.mockResolvedValue(scanOf(dirty));
		await scanProjectWorktrees("/work/app");
		setLowDiskSpace({ projectPaths: ["/work/app"], freeBytes: 1024 });
		expect(lowDiskOffer(getWorktreeReclaimState())).toBeNull();

		scanReclaimableWorktrees.mockResolvedValue(scanOf(clean));
		await scanProjectWorktrees("/work/app");
		expect(lowDiskOffer(getWorktreeReclaimState())).not.toBeNull();
		dismissLowDiskNotice();
		expect(lowDiskOffer(getWorktreeReclaimState())).toBeNull();
		// Space recovered, then ran low again: the notice may return.
		setLowDiskSpace(null);
		setLowDiskSpace({ projectPaths: ["/work/app"], freeBytes: 1024 });
		expect(lowDiskOffer(getWorktreeReclaimState())).not.toBeNull();
	});
});
