import type { DetectedWorktreeSession } from "@/lib/spaces/detectedWorktreeSessions";

export const DETECTED_WORKTREE_HIDDEN_LIMIT = 512;

const IDENTITY_MEMBER_LIMIT = 4 * 1024;

export interface HiddenDetectedWorktree {
	readonly key: string;
	readonly branch: string;
	readonly observedActivityAt: number;
	readonly observedSessionCount: number;
}

function validIdentityMember(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= IDENTITY_MEMBER_LIMIT
	);
}

function validCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function detectedWorktreeVisibilityKey(
	session: DetectedWorktreeSession,
): string {
	return JSON.stringify([
		session.projectId,
		session.projectKind,
		session.sshHostId ?? "local",
		session.worktree.path,
	]);
}

function hiddenDetectedWorktreeObservation(
	session: DetectedWorktreeSession,
): HiddenDetectedWorktree {
	return {
		key: detectedWorktreeVisibilityKey(session),
		branch: session.worktree.branch,
		observedActivityAt: Math.max(
			session.worktree.claudeLastTs ?? 0,
			session.worktree.codexLastTs ?? 0,
		),
		observedSessionCount:
			session.worktree.claudeSessions + session.worktree.codexSessions,
	};
}

export function isHiddenDetectedWorktree(
	session: DetectedWorktreeSession,
	hidden: readonly HiddenDetectedWorktree[],
): boolean {
	const current = hiddenDetectedWorktreeObservation(session);
	const observation = hidden.find((entry) => entry.key === current.key);
	if (!observation || observation.branch !== current.branch) return false;
	return (
		current.observedActivityAt <= observation.observedActivityAt &&
		current.observedSessionCount <= observation.observedSessionCount
	);
}

function isHiddenDetectedWorktreeRecord(
	value: unknown,
): value is HiddenDetectedWorktree {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<HiddenDetectedWorktree>;
	return (
		validIdentityMember(record.key) &&
		typeof record.branch === "string" &&
		record.branch.length <= IDENTITY_MEMBER_LIMIT &&
		validCount(record.observedActivityAt) &&
		validCount(record.observedSessionCount)
	);
}

export function normalizeHiddenDetectedWorktrees(
	value: unknown,
): HiddenDetectedWorktree[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const normalized: HiddenDetectedWorktree[] = [];
	for (let index = value.length - 1; index >= 0; index -= 1) {
		const record = value[index];
		if (!isHiddenDetectedWorktreeRecord(record) || seen.has(record.key)) {
			continue;
		}
		seen.add(record.key);
		normalized.push(record);
		if (normalized.length === DETECTED_WORKTREE_HIDDEN_LIMIT) break;
	}
	return normalized.reverse();
}

export function hideDetectedWorktree(
	current: readonly HiddenDetectedWorktree[],
	session: DetectedWorktreeSession,
): readonly HiddenDetectedWorktree[] {
	const next = hiddenDetectedWorktreeObservation(session);
	const retained = current.filter((record) => record.key !== next.key);
	return normalizeHiddenDetectedWorktrees([...retained, next]);
}
