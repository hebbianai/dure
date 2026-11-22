// Finished-worktree scans per local project and the low-disk offer (#623).
//
// Settings → Storage and the low-disk notice read one state: a scan made for
// the notice is the list the page opens on, and a removal on the page clears
// the notice. The backend's checkout authority owns every decision; this only
// remembers its latest answers for the window.

import { reclaimWorktrees, scanReclaimableWorktrees } from "@/lib/ipc";
import { createValueStore } from "@/lib/state/broadcast";
import {
	removableBytes,
	removableWorktrees,
	summarizeWorktreeReclaim,
	type WorktreeReclaimScan,
	type WorktreeReclaimSummary,
} from "@/lib/scm/worktrees/worktreeReclaim";

export type ProjectWorktreeReclaim =
	| { status: "scanning"; scan?: WorktreeReclaimScan }
	| {
			status: "ready";
			scan: WorktreeReclaimScan;
			scannedAtMs: number;
			/** The last removal's result, until the next one. */
			summary?: WorktreeReclaimSummary;
	  }
	| { status: "removing"; scan: WorktreeReclaimScan }
	| { status: "error"; message: string; scan?: WorktreeReclaimScan };

/** Projects on a volume whose free space is low, and how much is left. */
export interface LowDiskSpace {
	projectPaths: readonly string[];
	freeBytes: number;
}

export interface WorktreeReclaimState {
	/** Keyed by the project's registered local path. */
	projects: Readonly<Record<string, ProjectWorktreeReclaim>>;
	lowDisk: LowDiskSpace | null;
	/** The person closed the notice; it returns after space recovers and runs
	 *  low again, or after the app restarts. */
	lowDiskDismissed: boolean;
}

const store = createValueStore<WorktreeReclaimState>({
	projects: {},
	lowDisk: null,
	lowDiskDismissed: false,
});

export const subscribeWorktreeReclaim = store.subscribe;
export const getWorktreeReclaimState = store.get;

function setProject(path: string, next: ProjectWorktreeReclaim): void {
	const state = store.get();
	store.set({ ...state, projects: { ...state.projects, [path]: next } });
}

function lastScan(path: string): WorktreeReclaimScan | undefined {
	return store.get().projects[path]?.scan;
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** One scan per project at a time; a second request waits on the first. */
const scansInFlight = new Map<string, Promise<void>>();

export function scanProjectWorktrees(path: string): Promise<void> {
	const running = scansInFlight.get(path);
	if (running) return running;
	const current = store.get().projects[path];
	if (current?.status === "removing") return Promise.resolve();
	const summary = current?.status === "ready" ? current.summary : undefined;
	setProject(path, { status: "scanning", scan: lastScan(path) });
	const scan = scanReclaimableWorktrees(path)
		.then((result) =>
			setProject(path, {
				status: "ready",
				scan: result,
				scannedAtMs: Date.now(),
				...(summary ? { summary } : {}),
			}),
		)
		.catch((cause) =>
			setProject(path, {
				status: "error",
				message: message(cause),
				scan: lastScan(path),
			}),
		)
		.finally(() => scansInFlight.delete(path));
	scansInFlight.set(path, scan);
	return scan;
}

/** Remove every worktree the latest scan offered, then look again. */
export async function reclaimProjectWorktrees(path: string): Promise<void> {
	const current = store.get().projects[path];
	if (current?.status !== "ready") return;
	const instances = removableWorktrees(current.scan).map(
		(checkout) => checkout.instance,
	);
	if (instances.length === 0) return;
	setProject(path, { status: "removing", scan: current.scan });
	let summary: WorktreeReclaimSummary;
	try {
		summary = summarizeWorktreeReclaim(
			instances,
			await reclaimWorktrees(path, instances),
		);
	} catch (cause) {
		setProject(path, {
			status: "error",
			message: message(cause),
			scan: current.scan,
		});
		return;
	}
	setProject(path, { ...current, summary });
	await scanProjectWorktrees(path);
}

export function setLowDiskSpace(lowDisk: LowDiskSpace | null): void {
	const state = store.get();
	store.set({
		...state,
		lowDisk,
		lowDiskDismissed: lowDisk ? state.lowDiskDismissed : false,
	});
}

export function dismissLowDiskNotice(): void {
	store.set({ ...store.get(), lowDiskDismissed: true });
}

export interface LowDiskOffer {
	freeBytes: number;
	projectPaths: string[];
	count: number;
	bytes: number;
}

/** What the notice offers: the removable worktrees in the projects on a low
 *  volume. Nothing to remove means no notice. */
export function lowDiskOffer(state: WorktreeReclaimState): LowDiskOffer | null {
	if (!state.lowDisk || state.lowDiskDismissed) return null;
	const offer: LowDiskOffer = {
		freeBytes: state.lowDisk.freeBytes,
		projectPaths: [],
		count: 0,
		bytes: 0,
	};
	for (const path of state.lowDisk.projectPaths) {
		const project = state.projects[path];
		if (project?.status !== "ready") continue;
		const count = removableWorktrees(project.scan).length;
		if (count === 0) continue;
		offer.projectPaths.push(path);
		offer.count += count;
		offer.bytes += removableBytes(project.scan);
	}
	return offer.count > 0 ? offer : null;
}

/** Tests only. */
export function resetWorktreeReclaimStoreForTest(): void {
	scansInFlight.clear();
	store.set({ projects: {}, lowDisk: null, lowDiskDismissed: false });
}
