// Finished Run worktrees offered back to the disk (#623) — pure rules.
//
// The backend's checkout authority decides which linked worktrees it created
// and whether each may go; this module only parses its answer, totals it and
// decides when free space is low enough to say so.

import {
	type GitCheckoutInstanceV1,
	isGitCheckoutInstanceV1,
} from "@/lib/scm/worktrees/gitCheckoutInstance";
import type { Project } from "@/types";

/** Projects whose worktrees this machine can scan: registered, local, Git. */
export function localRepositoryProjects(projects: readonly Project[]): Project[] {
	return projects.filter((project) => project.kind === "local" && project.isRepo);
}

/** Why a worktree the product created is kept. */
export type WorktreeReclaimHold =
	| "in_use"
	| "locked"
	| "dirty"
	| "detached_unreachable"
	| "unavailable";

const HOLDS: readonly WorktreeReclaimHold[] = [
	"in_use",
	"locked",
	"dirty",
	"detached_unreachable",
	"unavailable",
];

export interface WorktreeReclaimCandidate {
	instance: GitCheckoutInstanceV1;
	/** Checked-out branch; null when HEAD is detached. */
	branch: string | null;
	/** null when it may be removed. */
	hold: WorktreeReclaimHold | null;
	/** Bytes removal frees; measured only for a removable worktree. */
	sizeBytes: number | null;
}

export interface WorktreeReclaimScan {
	repositoryPath: string;
	checkouts: WorktreeReclaimCandidate[];
}

export type WorktreeReclaimOutcome =
	| { outcome: "removed"; freedBytes: number }
	| { outcome: "kept"; hold: WorktreeReclaimHold }
	| { outcome: "failed"; code: string; message: string };

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isHold(value: unknown): value is WorktreeReclaimHold {
	return HOLDS.includes(value as WorktreeReclaimHold);
}

function isByteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseCandidate(value: unknown): WorktreeReclaimCandidate {
	const candidate = record(value);
	if (
		!candidate ||
		!isGitCheckoutInstanceV1(candidate.instance) ||
		!(candidate.branch === null || typeof candidate.branch === "string") ||
		!(candidate.hold === null || isHold(candidate.hold)) ||
		!(candidate.sizeBytes === null || isByteCount(candidate.sizeBytes))
	) {
		throw new Error("Invalid worktree reclaim candidate");
	}
	return {
		instance: candidate.instance,
		branch: candidate.branch,
		hold: candidate.hold,
		sizeBytes: candidate.sizeBytes,
	};
}

/** Parses one project's scan at the IPC boundary. */
export function parseWorktreeReclaimScan(value: unknown): WorktreeReclaimScan {
	const scan = record(value);
	if (
		!scan ||
		typeof scan.repositoryPath !== "string" ||
		!Array.isArray(scan.checkouts)
	) {
		throw new Error("Invalid worktree reclaim scan");
	}
	return {
		repositoryPath: scan.repositoryPath,
		checkouts: scan.checkouts.map(parseCandidate),
	};
}

function parseOutcome(value: unknown): WorktreeReclaimOutcome {
	const outcome = record(value);
	if (outcome?.outcome === "removed" && isByteCount(outcome.freedBytes)) {
		return { outcome: "removed", freedBytes: outcome.freedBytes };
	}
	if (outcome?.outcome === "kept" && isHold(outcome.hold)) {
		return { outcome: "kept", hold: outcome.hold };
	}
	if (
		outcome?.outcome === "failed" &&
		typeof outcome.code === "string" &&
		typeof outcome.message === "string"
	) {
		return { outcome: "failed", code: outcome.code, message: outcome.message };
	}
	throw new Error("Invalid worktree reclaim outcome");
}

/** One outcome per requested worktree, in request order. */
export function parseWorktreeReclaimOutcomes(
	value: unknown,
	requested: number,
): WorktreeReclaimOutcome[] {
	if (!Array.isArray(value) || value.length !== requested) {
		throw new Error("Invalid worktree reclaim outcomes");
	}
	return value.map(parseOutcome);
}

export function removableWorktrees(
	scan: WorktreeReclaimScan,
): WorktreeReclaimCandidate[] {
	return scan.checkouts.filter((checkout) => checkout.hold === null);
}

export function keptWorktrees(
	scan: WorktreeReclaimScan,
): (WorktreeReclaimCandidate & { hold: WorktreeReclaimHold })[] {
	return scan.checkouts.filter(
		(checkout): checkout is WorktreeReclaimCandidate & {
			hold: WorktreeReclaimHold;
		} => checkout.hold !== null,
	);
}

export function removableBytes(scan: WorktreeReclaimScan): number {
	return removableWorktrees(scan).reduce(
		(total, checkout) => total + (checkout.sizeBytes ?? 0),
		0,
	);
}

/** The worktree's path under the repository root when it lies there
 *  (`.worktrees/name`), otherwise its full path. */
export function worktreeDisplayPath(
	repositoryPath: string,
	checkout: WorktreeReclaimCandidate,
): string {
	const path = checkout.instance.canonicalPath;
	const root = repositoryPath.replace(/[\\/]+$/, "");
	const rest = path.slice(root.length);
	return path.startsWith(root) && /^[\\/]/.test(rest) && rest.length > 1
		? rest.slice(1)
		: path;
}

export interface WorktreeReclaimSummary {
	removed: number;
	freedBytes: number;
	/** Each worktree that changed since it was offered, with its reason. */
	kept: { instance: GitCheckoutInstanceV1; hold: WorktreeReclaimHold }[];
	failed: { instance: GitCheckoutInstanceV1; message: string }[];
}

export function summarizeWorktreeReclaim(
	requested: readonly GitCheckoutInstanceV1[],
	outcomes: readonly WorktreeReclaimOutcome[],
): WorktreeReclaimSummary {
	const summary: WorktreeReclaimSummary = {
		removed: 0,
		freedBytes: 0,
		kept: [],
		failed: [],
	};
	outcomes.forEach((outcome, index) => {
		const instance = requested[index];
		if (outcome.outcome === "removed") {
			summary.removed += 1;
			summary.freedBytes += outcome.freedBytes;
		} else if (outcome.outcome === "kept") {
			summary.kept.push({ instance, hold: outcome.hold });
		} else {
			summary.failed.push({ instance, message: outcome.message });
		}
	});
	return summary;
}

const GIB = 1024 ** 3;
/** A release build of the desktop app alone needs well over 10 GiB. */
const LOW_DISK_FREE_BYTES = 20 * GIB;
/** On a small disk, a tenth of it is the line instead. */
const LOW_DISK_FREE_FRACTION = 0.1;

export interface VolumeSpace {
	freeBytes: number;
	totalBytes: number;
}

/** Low means below 20 GiB free, or below a tenth of a disk smaller than
 *  200 GiB. A disk Dure could not measure is never called low. */
export function isLowDiskSpace(space: VolumeSpace | null): boolean {
	if (!space || space.totalBytes <= 0) return false;
	return (
		space.freeBytes <
		Math.min(LOW_DISK_FREE_BYTES, space.totalBytes * LOW_DISK_FREE_FRACTION)
	);
}

export function parseVolumeSpaces(
	value: unknown,
	requested: number,
): (VolumeSpace | null)[] {
	if (!Array.isArray(value) || value.length !== requested) {
		throw new Error("Invalid volume space response");
	}
	return value.map((entry) => {
		if (entry === null) return null;
		const space = record(entry);
		if (!space || !isByteCount(space.freeBytes) || !isByteCount(space.totalBytes)) {
			throw new Error("Invalid volume space");
		}
		return { freeBytes: space.freeBytes, totalBytes: space.totalBytes };
	});
}
