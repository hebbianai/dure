import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installLowDiskWorktreeService,
	LOW_DISK_CHECK_BOOT_DELAY_MS,
} from "@/lib/scm/worktrees/lowDiskWorktreeService";
import type { WorktreeReclaimState } from "@/lib/scm/worktrees/worktreeReclaimStore";

const GIB = 1024 ** 3;
const LOW = { freeBytes: 5 * GIB, totalBytes: 500 * GIB };
const ROOMY = { freeBytes: 200 * GIB, totalBytes: 500 * GIB };

function fixture(spaces: Record<string, typeof LOW | null>) {
	let state: WorktreeReclaimState = {
		projects: {},
		lowDisk: null,
		lowDiskDismissed: false,
	};
	const dependencies = {
		localProjectPaths: () => Object.keys(spaces),
		volumeSpace: vi.fn(async (paths: readonly string[]) =>
			paths.map((path) => spaces[path] ?? null),
		),
		scanProject: vi.fn(async (_path: string) => {}),
		setLowDisk: vi.fn((lowDisk: WorktreeReclaimState["lowDisk"]) => {
			state = { ...state, lowDisk };
		}),
		state: () => state,
		now: () => 10_000_000,
		scheduleInterval: vi.fn(() => "interval"),
		clearIntervalHandle: vi.fn(),
	};
	return {
		dependencies,
		setState: (next: Partial<WorktreeReclaimState>) => {
			state = { ...state, ...next };
		},
	};
}

async function firstPass() {
	await vi.advanceTimersByTimeAsync(LOW_DISK_CHECK_BOOT_DELAY_MS);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("low-disk worktree service", () => {
	it("scans only the projects on a low volume and records how much is left", async () => {
		const { dependencies } = fixture({ "/low/app": LOW, "/roomy/app": ROOMY });
		const stop = installLowDiskWorktreeService(dependencies);
		await firstPass();
		expect(dependencies.setLowDisk).toHaveBeenLastCalledWith({
			projectPaths: ["/low/app"],
			freeBytes: LOW.freeBytes,
		});
		expect(dependencies.scanProject.mock.calls).toEqual([["/low/app"]]);
		stop();
		expect(dependencies.clearIntervalHandle).toHaveBeenCalledWith("interval");
	});

	it("clears the offer once no volume is low", async () => {
		const { dependencies } = fixture({ "/roomy/app": ROOMY, "/unknown": null });
		installLowDiskWorktreeService(dependencies);
		await firstPass();
		expect(dependencies.setLowDisk).toHaveBeenLastCalledWith(null);
		expect(dependencies.scanProject).not.toHaveBeenCalled();
	});

	it("does not rescan a fresh list or scan after the notice was dismissed", async () => {
		const fresh = fixture({ "/low/app": LOW });
		fresh.setState({
			projects: {
				"/low/app": {
					status: "ready",
					scan: { repositoryPath: "/low/app", checkouts: [] },
					scannedAtMs: 10_000_000 - 60_000,
				},
			},
		});
		installLowDiskWorktreeService(fresh.dependencies);
		await firstPass();
		expect(fresh.dependencies.scanProject).not.toHaveBeenCalled();

		const dismissed = fixture({ "/low/app": LOW });
		dismissed.setState({ lowDiskDismissed: true });
		installLowDiskWorktreeService(dismissed.dependencies);
		await firstPass();
		expect(dismissed.dependencies.scanProject).not.toHaveBeenCalled();
	});

	it("never runs a pass after it is stopped", async () => {
		const { dependencies } = fixture({ "/low/app": LOW });
		const stop = installLowDiskWorktreeService(dependencies);
		stop();
		await firstPass();
		expect(dependencies.volumeSpace).not.toHaveBeenCalled();
	});
});
