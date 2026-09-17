import { describe, expect, it } from "vitest";
import {
	GIT_DIFF_BADGE_INTERVAL_MS,
	GIT_POLL_INTERVAL_MS,
	gitDiffBadgePollDue,
	type GitPollTarget,
	mergeGitPollTier,
	seedNewGitPollTargets,
	selectGitPollTarget,
} from "@/lib/scm/status/gitPollingPolicy";

const target = (key: string, tier: GitPollTarget["tier"]): GitPollTarget => ({
	key,
	tier,
});

describe("git polling policy", () => {
	it("polls only one target and gives a fresh focused pane first", () => {
		expect(
			selectGitPollTarget(
				[
					target("background", "background"),
					target("active", "active"),
					target("focus", "focused"),
				],
				new Map(),
				1_000,
			),
		).toEqual(target("focus", "focused"));
	});

	it("does not repoll a focused worktree before its deadline", () => {
		const now = 100_000;
		expect(
			selectGitPollTarget(
				[target("focus", "focused")],
				new Map([["focus", now - GIT_POLL_INTERVAL_MS.focused + 1]]),
				now,
			),
		).toBeUndefined();
	});

	it("serves the oldest overdue deadline so background work cannot starve", () => {
		const now = 1_000_000;
		expect(
			selectGitPollTarget(
				[target("focus", "focused"), target("background", "background")],
				new Map([
					["focus", now - GIT_POLL_INTERVAL_MS.focused],
					["background", now - GIT_POLL_INTERVAL_MS.background - 5_000],
				]),
				now,
			),
		).toEqual(target("background", "background"));
	});

	it("keeps the highest visibility tier when panes share a worktree", () => {
		expect(mergeGitPollTier("background", "focused")).toBe("focused");
		expect(mergeGitPollTier("active", "background")).toBe("active");
	});

	it("seeds only a cold focused worktree as immediately due", () => {
		const now = 1_000_000;
		const lastPolledAt = new Map<string, number>();
		const targets = [
			target("background", "background"),
			target("active", "active"),
			target("focus", "focused"),
		];
		seedNewGitPollTargets(targets, lastPolledAt, now);

		expect(selectGitPollTarget(targets, lastPolledAt, now)).toEqual(
			target("focus", "focused"),
		);
		expect(lastPolledAt.get("active")).toBe(now);
		expect(lastPolledAt.get("background")).toBe(now);
	});

	it("runs expensive diff badges less often than focused status", () => {
		const now = 1_000_000;
		const focus = target("focus", "focused");
		expect(gitDiffBadgePollDue(focus, new Map(), now)).toBe(true);
		expect(
			gitDiffBadgePollDue(
				focus,
				new Map([[focus.key, now - GIT_DIFF_BADGE_INTERVAL_MS.focused + 1]]),
				now,
			),
		).toBe(false);
		expect(
			gitDiffBadgePollDue(
				focus,
				new Map([[focus.key, now - GIT_DIFF_BADGE_INTERVAL_MS.focused]]),
				now,
			),
		).toBe(true);
	});

	/**
	 * 브랜치를 아무도 모르는 워크트리는 첫 읽기를 기다리지 않는다.
	 *
	 * 뱃지는 자문이라 10분을 기다려도 되지만, 브랜치는 폰과 사이드바에서 그
	 * 세션을 부르는 유일한 이름이다. 기존 체크아웃에 만든 에이전트는 레코드에도
	 * 브랜치가 없어서, 기다리면 앱을 켤 때마다 폰이 10분 동안
	 * "브랜치를 아직 받지 못했습니다" 라고 말한다.
	 */
	it("브랜치를 모르는 워크트리는 첫 읽기가 바로 밀린다", () => {
		const now = 1_000_000;
		const lastPolledAt = new Map<string, number>();
		const targets: GitPollTarget[] = [
			{ key: "known", tier: "background" },
			{ key: "unknown", tier: "background", branchUnknown: true },
		];

		seedNewGitPollTargets(targets, lastPolledAt, now);

		expect(selectGitPollTarget(targets, lastPolledAt, now)?.key).toBe("unknown");
		// 아는 쪽은 자기 티어를 그대로 지킨다 — 켤 때마다 전부 긁으면 그 상한이
		// 존재하는 이유가 사라진다.
		expect(lastPolledAt.get("known")).toBe(now);
	});

	/** 이미 한 번 읽은 대상은 다시 앞당기지 않는다. */
	it("이미 읽은 대상은 앞당기지 않는다", () => {
		const now = 1_000_000;
		const lastPolledAt = new Map<string, number>([["unknown", now]]);

		seedNewGitPollTargets(
			[{ key: "unknown", tier: "background", branchUnknown: true }],
			lastPolledAt,
			now,
		);

		expect(lastPolledAt.get("unknown")).toBe(now);
	});
});
