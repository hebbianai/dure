// SCM review store slice — per-agent git polling snapshots (gitStatuses /
// gitStatusErrors) and the volatile diff review comments collected per agent
// worktree. Extracted from store.ts as a composition slice (precedent:
// sessionRuntimeStoreSlice); implementations moved verbatim so update and
// no-op semantics are unchanged.
import { omitRecordKeys } from "@/lib/persistence/storeCollections";
import {
	createDiffComment,
	type DiffComment,
	markDeliveredMatching,
	type NewDiffComment,
	updateDiffCommentBody,
} from "@/lib/scm/review/diffComments";
import { planGitStatusUpdate } from "@/lib/scm/status/gitStatusEquality";
import type { GitStatus } from "@/types";

export interface ScmReviewStoreSlice {
	gitStatuses: Record<string, GitStatus>;
	gitStatusErrors: Record<string, string>;
	/** diff 리뷰 코멘트 — 에이전트(워크트리)별. 모아서 에이전트에 회신한다.
	 *  휘발(persist 제외 — 리뷰 세션 단위 임시 노트). */
	diffComments: Record<string, DiffComment[]>;

	setGitStatus: (agentId: string, s: GitStatus) => void;
	setGitStatusError: (agentId: string, message?: string) => void;
	/** diff 리뷰 코멘트 추가 — 생성된 코멘트를 돌려준다. */
	addDiffComment: (input: NewDiffComment) => DiffComment;
	/** 코멘트 본문 수정(edit-clears-sent). */
	updateDiffComment: (agentId: string, commentId: string, body: string) => void;
	removeDiffComment: (agentId: string, commentId: string) => void;
	/** 전달 스냅샷과 일치하는 코멘트에 sentAt를 찍는다. */
	markDiffCommentsSent: (
		agentId: string,
		snapshot: readonly { id: string; body: string }[],
		now: number,
	) => void;
}

type SliceSet = (
	updater: (
		state: ScmReviewStoreSlice,
	) => ScmReviewStoreSlice | Partial<ScmReviewStoreSlice>,
) => void;

export function createScmReviewStoreSlice(set: SliceSet): ScmReviewStoreSlice {
	return {
		gitStatuses: {},
		gitStatusErrors: {},
		diffComments: {},

		addDiffComment: (input) => {
			const comment = createDiffComment(input);
			set((s) => ({
				diffComments: {
					...s.diffComments,
					[input.agentId]: [...(s.diffComments[input.agentId] ?? []), comment],
				},
			}));
			return comment;
		},
		updateDiffComment: (agentId, commentId, body) =>
			set((s) => {
				const list = s.diffComments[agentId];
				if (!list) return {};
				return {
					diffComments: {
						...s.diffComments,
						[agentId]: list.map((c) =>
							c.id === commentId ? updateDiffCommentBody(c, body) : c,
						),
					},
				};
			}),
		removeDiffComment: (agentId, commentId) =>
			set((s) => {
				const list = s.diffComments[agentId];
				if (!list) return {};
				return {
					diffComments: {
						...s.diffComments,
						[agentId]: list.filter((c) => c.id !== commentId),
					},
				};
			}),
		markDiffCommentsSent: (agentId, snapshot, now) =>
			set((s) => {
				const list = s.diffComments[agentId];
				if (!list) return {};
				return {
					diffComments: {
						...s.diffComments,
						[agentId]: markDeliveredMatching(list, snapshot, now),
					},
				};
			}),
		// 변화 없는 폴링 결과는 state 자신을 반환해 리스너 통지를 생략한다
		// (5초 git 폴링의 무의미한 셀렉터 재실행·재렌더 차단) — lib/gitStatusEquality.
		setGitStatus: (agentId, st) =>
			set((s) => planGitStatusUpdate(s, agentId, st) ?? s),

		setGitStatusError: (agentId, message) =>
			set((s) => {
				const next = message?.trim().slice(0, 500);
				if (!next) {
					return {
						gitStatusErrors: omitRecordKeys(
							s.gitStatusErrors,
							new Set([agentId]),
						),
					};
				}
				if (s.gitStatusErrors[agentId] === next) return s;
				return {
					gitStatusErrors: { ...s.gitStatusErrors, [agentId]: next },
				};
			}),
	};
}
