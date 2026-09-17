export type GitPollTier = "focused" | "active" | "background";

export interface GitPollTarget {
	key: string;
	tier: GitPollTier;
	/**
	 * Nobody knows this worktree's branch yet — not the poller, not the agent
	 * record. See [`seedNewGitPollTargets`].
	 */
	branchUnknown?: boolean;
}

/**
 * Source-control badges are advisory. They must never compete with terminal
 * presentation at the old "every worktree every five seconds" cadence.
 */
export const GIT_POLL_INTERVAL_MS: Readonly<Record<GitPollTier, number>> = {
	focused: 15_000,
	active: 120_000,
	background: 600_000,
};

/** Numstat uses several Git subprocesses, plus a temporary index for new files. */
export const GIT_DIFF_BADGE_INTERVAL_MS: Readonly<Record<GitPollTier, number>> = {
	focused: 60_000,
	active: 300_000,
	background: 900_000,
};

const TIER_PRIORITY: Readonly<Record<GitPollTier, number>> = {
	focused: 2,
	active: 1,
	background: 0,
};

/** Pick at most one overdue worktree, ordered by its oldest deadline. */
export function selectGitPollTarget<T extends GitPollTarget>(
	targets: readonly T[],
	lastPolledAt: ReadonlyMap<string, number>,
	now: number,
): T | undefined {
	return targets
		.map((target) => {
			const last = lastPolledAt.get(target.key);
			return {
				target,
				dueAt:
					last === undefined
						? Number.NEGATIVE_INFINITY
						: last + GIT_POLL_INTERVAL_MS[target.tier],
			};
		})
		.filter(({ dueAt }) => dueAt <= now)
		.sort((left, right) => {
			const deadlineOrder =
				left.dueAt === right.dueAt ? 0 : left.dueAt < right.dueAt ? -1 : 1;
			return (
				deadlineOrder ||
				TIER_PRIORITY[right.target.tier] - TIER_PRIORITY[left.target.tier] ||
				left.target.key.localeCompare(right.target.key)
			);
		})[0]?.target;
}

export function mergeGitPollTier(
	left: GitPollTier,
	right: GitPollTier,
): GitPollTier {
	return TIER_PRIORITY[left] >= TIER_PRIORITY[right] ? left : right;
}

/**
 * Seed discovery time so a cold app does not drain every background worktree
 * at five-second intervals. Only the newly focused target is immediately due.
 *
 * The one exception is a worktree whose branch **nothing** knows yet. The
 * badges this cadence protects are advisory and can wait ten minutes; the
 * branch name cannot, because it is the only thing naming the session on the
 * phone and in the sidebar, and an agent created in an existing checkout is
 * registered with no branch at all (`agentRunWorkspacePresentation`). Waiting a
 * background interval there means the phone says "브랜치를 아직 받지
 * 못했습니다" for ten minutes after every launch.
 *
 * This stays bounded: a worktree an agent already carries a branch for is not
 * unknown, targets are keyed by path rather than by agent, and it is the first
 * read only — afterwards the target rejoins its tier.
 */
export function seedNewGitPollTargets(
	targets: readonly GitPollTarget[],
	lastPolledAt: Map<string, number>,
	now: number,
): void {
	let seededFocused = false;
	for (const target of targets) {
		if (lastPolledAt.has(target.key)) continue;
		const focusedFirst: boolean = target.tier === "focused" && !seededFocused;
		const immediatelyDue = focusedFirst || target.branchUnknown === true;
		lastPolledAt.set(
			target.key,
			immediatelyDue ? now - GIT_POLL_INTERVAL_MS[target.tier] : now,
		);
		seededFocused ||= focusedFirst;
	}
}

export function gitDiffBadgePollDue(
	target: GitPollTarget,
	lastPolledAt: ReadonlyMap<string, number>,
	now: number,
): boolean {
	const last = lastPolledAt.get(target.key);
	return last === undefined || now - last >= GIT_DIFF_BADGE_INTERVAL_MS[target.tier];
}
