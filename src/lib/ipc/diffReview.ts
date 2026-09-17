// ipc/diffReview — 에이전트 diff 리뷰.
//
// ipc.ts 도메인 분할 1단계(2026-08-01): 내용은 구 src/lib/ipc.ts에서 그대로
// 옮겨졌고, 소비자는 barrel(src/lib/ipc.ts)을 통해 기존 경로를 유지한다.
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).

import { invoke } from "@tauri-apps/api/core";
import { gitExecLocal } from "./git";

// ---------- agent diff review ----------

export interface DiffFileStat {
	path: string;
	/** rename 시 이전 경로 */
	oldPath: string | null;
	/** null = binary */
	added: number | null;
	deleted: number | null;
	/** git name-status 첫 글자: A/M/D/R/C/T */
	status: string;
}

export interface AgentDiffStat {
	baseRef: string;
	mergeBase: string;
	/** Newer backends split committed branch work from local WIP. */
	committedFiles?: DiffFileStat[];
	worktreeFiles?: DiffFileStat[];
	ahead?: number;
	behind?: number;
	files: DiffFileStat[];
}

/** 워크트리의 fork-point(기본 브랜치와의 merge-base) 대비 파일별 numstat. */
/** 이 브랜치에 열린 리뷰, 또는 왜 못 물었는지. */
export type ForgeReviewAnswer =
	| { kind: "open"; review: ForgeReviewRow }
	| { kind: "none" }
	| { kind: "unavailable"; reason: string };

export interface ForgeReviewRow {
	number: number;
	title: string;
	state: string;
	url: string;
	isDraft: boolean;
	baseRef: string;
	/** 리뷰가 요청된 사람들의 로그인. 팀은 여기 없다. */
	requestedReviewers: string[];
	/** 호스트의 리뷰 판정. 아무도 아직 안 봤으면 빈 문자열이다. */
	reviewDecision: string;
	/** 호스트의 체크 요약. 못 물어봤으면 없다 — "체크 없음" 과 다른 사실이다. */
	checks?: { total: number; passed: number; failed: number; pending: number };
}

type ForgeReviewWire =
	| ({ kind: "open" } & ForgeReviewRow)
	| { kind: "none" }
	| { kind: "unavailable"; reason: string };

function forgeAnswer(wire: ForgeReviewWire): ForgeReviewAnswer {
	if (wire.kind === "open") {
		const { kind: _kind, ...review } = wire;
		return { kind: "open", review };
	}
	return wire;
}

/** 이 브랜치에 열린 리뷰. */
export const agentPullRequest = async (path: string, branch: string) =>
	forgeAnswer(await invoke<ForgeReviewWire>("agent_pull_request", { path, branch }));

/**
 * 이 브랜치에 리뷰를 연다.
 *
 * 바깥으로 나가는 유일한 호출이다. 값 셋만 넘어가고 argv 는 백엔드에 고정돼
 * 있다 — 저장소와 브랜치는 워크트리에서 나온다.
 */
export const agentPullRequestCreate = async (
	path: string,
	branch: string,
	draft: { title: string; body: string; draft: boolean },
) =>
	forgeAnswer(
		await invoke<ForgeReviewWire>("agent_pull_request_create", {
			path,
			branch,
			title: draft.title,
			body: draft.body,
			draft: draft.draft,
		}),
	);

/** 커밋 하나. 폰의 커밋 탭이 한 줄로 그린다. */
export interface AgentCommit {
	shortSha: string;
	subject: string;
	author: string;
	/** 사람이 읽는 상대 시각. 백엔드가 이미 사람 말로 만들어 보낸다. */
	when: string;
}

/** 기준 브랜치 이후의 커밋들. `agentDiffStat` 과 같은 기준을 쓴다. */
export const agentCommits = (path: string, baseRef?: string) =>
	invoke<AgentCommit[]>("agent_commits", { path, baseRef: baseRef ?? null });

/** 파일 하나의 패치. 폰이 목록에서 한 줄을 눌렀을 때 쓴다. */
export interface AgentFileDiff {
	path: string;
	/** null = binary. 빈 문자열("바뀐 게 없다")과 다른 답이다. */
	patch: string | null;
	added: number | null;
	deleted: number | null;
}

/**
 * 목록에 있는 파일 하나의 패치.
 *
 * 전체 diff 를 받아 프론트에서 쪼개지 않는다 — 그 길은 줄 하나를 누를 때마다
 * 워크트리 전체의 본문을 IPC 로 태운다. 경로가 그 비교에 실제로 있는지는
 * 백엔드가 같은 스냅샷에서 확인한다.
 */
export const agentFileDiff = (
	path: string,
	file: string,
	commit?: string,
	baseRef?: string,
) =>
	invoke<AgentFileDiff>("agent_file_diff", {
		path,
		file,
		commit: commit ?? null,
		baseRef: baseRef ?? null,
	});

/** 폰이 부탁할 수 있는 저장소 변경, 전부. Rust `scm_write::Action` 의 거울. */
export type ScmWriteAction =
	| { kind: "commit"; paths: string[]; message: string }
	| { kind: "discard"; paths: string[] }
	| { kind: "checkout"; branch: string }
	| { kind: "create_branch"; name: string }
	/** 지금 브랜치를 원격에 올린다. 강제는 없다 — `scm_write.rs` 참조. */
	| { kind: "push" };

/** 무엇이 일어났는지. 갈래마다 할 말이 다르다. */
export type ScmWriteReceipt =
	| { kind: "commit"; shortSha: string; files: number }
	/** 되돌린 파일과 **지운** 파일. 지운 쪽은 git 이 되돌려 주지 않는다. */
	| { kind: "discard"; restored: number; deleted: number }
	| { kind: "branch"; name: string }
	/** `published` 는 이번에 원격에 처음 생긴 브랜치라는 뜻이다. */
	| { kind: "push"; branch: string; remote: string; published: boolean };

/**
 * 저장소를 바꾼다.
 *
 * `gitExecLocal` 이 아니다. 그것은 이 컴퓨터 앞에 앉은 사람의 것이고, 이쪽은
 * 페어링된 폰이 보낸 값이 닿는 길이다 — 프로그램 이름과 플래그는 전부
 * 백엔드에 고정돼 있고, 폰이 정하는 것은 무엇에 적용할지뿐이다.
 */
export const agentScmWrite = (path: string, action: ScmWriteAction) =>
	invoke<ScmWriteReceipt>("agent_scm_write", { path, action });

/** 이 저장소의 브랜치들. 전환 시트가 열릴 때 한 번 읽는다. */
export interface AgentBranch {
	name: string;
	current: boolean;
	/** 다른 워크트리가 쓰고 있으면 그 경로. git 이 그 브랜치로의 전환을 거절한다. */
	checkedOutAt: string | null;
	commits: number | null;
	when: string | null;
}

export const agentBranches = (path: string) => invoke<AgentBranch[]>("agent_branches", { path });

/** 커밋 하나가 무엇을 했는지 — 목록에 없던 본문과 파일들. */
export interface AgentCommitDetail {
	/** git 이 정규화한 짧은 sha. 폰이 보낸 값이 아니라 저장소가 확인한 값이다. */
	shortSha: string;
	/** 제목 뒤의 본문. 없으면 `null` — 빈 문자열이 아니다. */
	body: string | null;
	files: DiffFileStat[];
}

export const agentCommitDetail = (path: string, commit: string) =>
	invoke<AgentCommitDetail>("agent_commit_detail", { path, commit });

/** 리뷰를 부탁할 수 있는 사람 하나. */
export interface AgentReviewer {
	login: string;
	/** 커밋이 들고 있는 이름. 없을 수 있고, 그때는 화면이 로그인만 그린다. */
	name: string;
}

/**
 * 리뷰를 부탁할 만한 사람들, 최근 함께 일한 순.
 *
 * `null` 은 못 물어봤다는 뜻이다 — 빈 목록("함께 커밋한 사람이 없다")과 다른
 * 사실이라, 백엔드가 `Option` 으로 준다.
 */
export const agentReviewerCandidates = (path: string) =>
	invoke<AgentReviewer[] | null>("agent_reviewer_candidates", { path });

/**
 * 이 리뷰의 리뷰어를 바꾼다. 더할 사람과 뺄 사람만.
 *
 * 집합이 아니라 델타인 이유는 `forge.rs` 에 있다 — 목록에 없던 팀을 이 화면이
 * 지우지 않게 한다.
 */
export const agentSetReviewers = (
	path: string,
	number: number,
	add: readonly string[],
	remove: readonly string[],
) => invoke<void>("agent_set_reviewers", { path, number, add, remove });

export const agentDiffStat = (path: string, baseRef?: string) =>
	invoke<AgentDiffStat>("agent_diff_stat", { path, baseRef: baseRef ?? null });

/** 워크트리의 fork-point 대비 full unified diff (파일별 분리는 splitDiffSections). */
export const agentDiff = (path: string, baseRef?: string) =>
	invoke<string>("agent_diff", { path, baseRef: baseRef ?? null });

export interface AgentDiffReview extends AgentDiffStat {
	/** 입력 cwd가 속한 실제 Git worktree root */
	worktreePath: string;
	/** files와 같은 스냅샷에서 나온 full unified diff */
	diff: string;
}

/** 패널 새로고침용: 같은 스냅샷에서 stat + full diff를 한 번에. */
export const agentDiffReview = (path: string, baseRef?: string) =>
	invoke<AgentDiffReview>("agent_diff_review", {
		path,
		baseRef: baseRef ?? null,
	});

export interface ReviewTargetRecordV1 {
	reviewId: string;
	worktreePath: string;
	worktreeGitDir: string;
	baseRef: string;
	baseCommitSha: string;
	headCommitSha: string;
	sourceSessionId: string | null;
	feedbackAgentId: string | null;
	createdAtMs: number;
}

export interface ReviewSnapshotV1 {
	target: ReviewTargetRecordV1;
	review: AgentDiffReview;
}

export const createDiffReviewTarget = (input: {
	reviewId: string;
	path: string;
	sourceSessionId?: string;
	feedbackAgentId?: string;
}) =>
	invoke<ReviewTargetRecordV1>("diff_review_target_create", {
		reviewId: input.reviewId,
		path: input.path,
		sourceSessionId: input.sourceSessionId ?? null,
		feedbackAgentId: input.feedbackAgentId ?? null,
	});

export const diffReviewSnapshot = (reviewId: string) =>
	invoke<ReviewSnapshotV1>("diff_review_snapshot", { reviewId });

export interface ReviewTargetSweepReceiptV1 {
	activeTargets: number;
	inactiveTargets: number;
	deletedTargets: number;
}

export const reconcileDiffReviewTargets = (
	activeReviewIds: readonly string[],
	observedAtMs: number,
) =>
	invoke<ReviewTargetSweepReceiptV1>("diff_review_targets_reconcile", {
		activeReviewIds,
		observedAtMs,
	});

/** Diff 메뉴 capability용 read-only Git root probe. 최종 검증은 review command가 다시 한다. */
export const probeGitWorktreeRoot = (path: string) =>
	gitExecLocal(path, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);

/** Claude 실측 rate-limit 수집기(statusLine) 상태 — src-tauri claude_collector. */
export type ClaudeCollectorState = "installed" | "not_installed" | "foreign";

export const claudeCollectorStatus = () =>
	invoke<ClaudeCollectorState>("claude_collector_status");
