// Watches free space on the volumes holding local projects (#623).
//
// Finished Run worktrees are kept, and nothing else reclaims them; a project
// with hundreds of them can leave too little room for a build. When a
// project's volume runs low this scans that project's worktrees once, so the
// notice can say how many are safe to remove and how much they free. The scan
// and every removal stay with the backend's checkout authority.

import {
	clearMaintenanceLaneInterval,
	setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";
import {
	isLowDiskSpace,
	type VolumeSpace,
} from "@/lib/scm/worktrees/worktreeReclaim";
import type {
	LowDiskSpace,
	WorktreeReclaimState,
} from "@/lib/scm/worktrees/worktreeReclaimStore";

/** Off the boot critical path. */
export const LOW_DISK_CHECK_BOOT_DELAY_MS = 60 * 1_000;
/** Disks fill over hours, not seconds. */
const LOW_DISK_CHECK_INTERVAL_MS = 15 * 60 * 1_000;
/** A scan walks every worktree; within this age the last answer stands. */
const SCAN_FRESH_MS = 60 * 60 * 1_000;

interface LowDiskWorktreeDependencies {
	/** Registered local Git projects' paths. */
	localProjectPaths(): string[];
	volumeSpace(paths: readonly string[]): Promise<(VolumeSpace | null)[]>;
	scanProject(path: string): Promise<void>;
	setLowDisk(lowDisk: LowDiskSpace | null): void;
	state(): WorktreeReclaimState;
	now?: () => number;
	scheduleInterval?: (callback: () => void, delayMs: number) => unknown;
	clearIntervalHandle?: (handle: unknown) => void;
}

/** Starts the periodic check. Main-window only — the caller gates. */
export function installLowDiskWorktreeService(
	dependencies: LowDiskWorktreeDependencies,
): () => void {
	const now = dependencies.now ?? Date.now;
	const scheduleInterval =
		dependencies.scheduleInterval ??
		((callback, delayMs) =>
			setMaintenanceLaneInterval(callback, delayMs, "low-disk-worktrees"));
	const clearIntervalHandle =
		dependencies.clearIntervalHandle ??
		((handle) =>
			clearMaintenanceLaneInterval(
				handle as ReturnType<typeof setMaintenanceLaneInterval>,
			));
	let disposed = false;
	let passInFlight = false;

	const pass = async () => {
		if (disposed || passInFlight) return;
		passInFlight = true;
		try {
			const paths = dependencies.localProjectPaths();
			const spaces = paths.length > 0 ? await dependencies.volumeSpace(paths) : [];
			if (disposed) return;
			const low = paths.flatMap((path, index) => {
				const space = spaces[index];
				return space && isLowDiskSpace(space) ? [{ path, space }] : [];
			});
			if (low.length === 0) {
				dependencies.setLowDisk(null);
				return;
			}
			dependencies.setLowDisk({
				projectPaths: low.map(({ path }) => path),
				freeBytes: Math.min(...low.map(({ space }) => space.freeBytes)),
			});
			for (const { path } of low) {
				const state = dependencies.state();
				if (disposed || state.lowDiskDismissed) return;
				const project = state.projects[path];
				const fresh =
					project?.status === "ready" &&
					now() - project.scannedAtMs < SCAN_FRESH_MS;
				if (!fresh) await dependencies.scanProject(path);
			}
		} catch (cause) {
			// The next interval is the retry; a missing number is not low space.
			console.warn("[low-disk] check failed", cause);
		} finally {
			passInFlight = false;
		}
	};

	const bootTimer = globalThis.setTimeout(() => {
		void pass();
	}, LOW_DISK_CHECK_BOOT_DELAY_MS);
	const timer = scheduleInterval(() => {
		void pass();
	}, LOW_DISK_CHECK_INTERVAL_MS);

	return () => {
		if (disposed) return;
		disposed = true;
		globalThis.clearTimeout(bootTimer);
		clearIntervalHandle(timer);
	};
}
