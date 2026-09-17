/**
 * Answering a phone that asked what a session changed.
 *
 * The mapping and the failure sentences live in [`answerHubGitStatus`]; the
 * table of sessions lives in [`useHubSessionLocations`], shared with every
 * other hub round trip that has to resolve one. This hook supplies only what
 * needs a running window: the `agent_diff_stat` command and its siblings.
 *
 * # Only the main window
 *
 * Every window hears the event. If each answered, the round trip would settle
 * on whichever reply arrived first and the rest would be discarded — harmless
 * but wasteful, and it would run `git diff` several times per press. Scoped the
 * from every window, so this hook scopes delivery to main before applying it.
 */

import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { useHubSessionLocations } from "@/components/hub/useHubSessionLocations";
import type { ForgeReviewAnswer as BridgeForgeAnswer } from "@/lib/hub/gitStatusBridge";
import type { ForgeReviewAnswer } from "@/lib/ipc/diffReview";
import {
	type HubGitStatusDispatch,
	answerHubGitStatus,
} from "@/lib/hub/gitStatusBridge";
import { gitStatus } from "@/lib/ipc/git";
import {
	agentCommits,
	agentDiffStat,
	agentPullRequest,
	agentBranches,
	agentCommitDetail,
	agentReviewerCandidates,
	agentPullRequestCreate,
	agentScmWrite,
	agentSetReviewers,
} from "@/lib/ipc/diffReview";
import { hubGitStatusResult, hubRemoteGitStatus } from "@/lib/ipc/system";
import { isMainWindow } from "@/lib/workspace/window/windows";

/** 백엔드가 부르는 이름을 약속이 부르는 이름으로. */
function onTheWire(answer: ForgeReviewAnswer): BridgeForgeAnswer {
	if (answer.kind !== "open") return answer;
	const { number, title, state, url, isDraft, baseRef, requestedReviewers, reviewDecision, checks } =
		answer.review;
	return {
		kind: "open",
		review: {
			number,
			title,
			state,
			url,
			is_draft: isDraft,
			base_ref: baseRef,
			requested_reviewers: requestedReviewers,
			review_decision: reviewDecision,
			...(checks === undefined ? {} : { checks }),
		},
	};
}

export function useHubGitStatus(): void {
	const current = useHubSessionLocations();

	useEffect(() => {
		if (!isMainWindow()) return;
		let disposed = false;
		const pending = listen<HubGitStatusDispatch>("hub://git-status", (event) => {
			void answerHubGitStatus(event.payload, {
				locate: (sessionId) => current.current.get(sessionId),
				status: (worktreePath) => gitStatus(worktreePath),
				diffStat: (worktreePath) => agentDiffStat(worktreePath),
				// 백엔드는 camelCase, 약속은 snake_case 다. 커밋과 같은 자리에서
				// 한 번만 옮긴다.
				review: async (worktreePath, branch) =>
					onTheWire(await agentPullRequest(worktreePath, branch)),
				createReview: async (worktreePath, branch, draft) =>
					onTheWire(await agentPullRequestCreate(worktreePath, branch, draft)),
				// 약속의 갈래와 백엔드의 갈래가 같은 모양이라 그대로 넘어간다.
				// 다르면 `serde` 가 경계에서 거절하고, 그것이 두 벌이 갈렸다는
				// 신호다 — 조용히 다른 일을 하는 것보다 낫다.
				write: (worktreePath, action) => agentScmWrite(worktreePath, action),
				// 백엔드는 camelCase, 약속은 snake_case 다. 커밋과 같은 자리에서
				// 한 번만 옮긴다.
				commitDetail: (worktreePath, commit) => agentCommitDetail(worktreePath, commit),
				reviewerCandidates: (worktreePath) => agentReviewerCandidates(worktreePath),
				setReviewers: (worktreePath, number, add, remove) =>
					agentSetReviewers(worktreePath, number, add, remove),
				branches: async (worktreePath) =>
					(await agentBranches(worktreePath)).map((branch) => ({
						name: branch.name,
						current: branch.current,
						...(branch.checkedOutAt === null ? {} : { checked_out_at: branch.checkedOutAt }),
						...(branch.when === null ? {} : { when: branch.when }),
					})),
				// 백엔드는 camelCase, 약속은 snake_case 다. 한 번만 옮긴다.
				commits: async (worktreePath) =>
					(await agentCommits(worktreePath)).map((commit) => ({
						short_sha: commit.shortSha,
						subject: commit.subject,
						author: commit.author,
						when: commit.when,
					})),
				remoteStatus: (boxId, sessionId, workspaceId, want) =>
					hubRemoteGitStatus(boxId, sessionId, workspaceId, want),
				report: hubGitStatusResult,
			});
		});
		void pending.then((unlisten) => {
			if (disposed) unlisten();
		});
		return () => {
			disposed = true;
			void pending.then((unlisten) => unlisten());
		};
	}, []);
}
