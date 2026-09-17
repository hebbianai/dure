import { beforeEach, describe, expect, it } from "vitest";
import type { RemoteGitStatus, SourceControlAction } from "./gitStatusBridge";
import { type HubGitStatusReply, answerHubGitStatus } from "@/lib/hub/gitStatusBridge";
import type { AgentDiffStat } from "@/lib/ipc/diffReview";
import { setLang } from "@/lib/i18n";
import type { GitStatus } from "@/types";

function stat(partial: Partial<AgentDiffStat> = {}): AgentDiffStat {
	return { baseRef: "main", mergeBase: "abc123", files: [], ...partial };
}

function repo(partial: Partial<GitStatus> = {}): GitStatus {
	return {
		isRepo: true,
		branch: "fix/payment-retry",
		ahead: 2,
		behind: 0,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		...partial,
	};
}

function collect() {
	const sent: { requestId: string; reply: HubGitStatusReply }[] = [];
	const written: { worktreePath: string; action: SourceControlAction }[] = [];
	return {
		sent,
		written,
		report: async (requestId: string, reply: HubGitStatusReply) => {
			sent.push({ requestId, reply });
		},
		write: async (worktreePath: string, action: SourceControlAction) => {
			written.push({ worktreePath, action });
		},
	};
}

beforeEach(() => setLang("en"));

/** 상자가 답한 모양 하나. 시험은 관심 있는 자리만 말한다. */
function boxAnswer(partial: Partial<RemoteGitStatus> = {}): RemoteGitStatus {
	return {
		kind: "read",
		reason: null,
		branch: "fix/payment-retry",
		ahead: null,
		behind: null,
		baseRef: null,
		files: [],
		filesRead: false,
		commits: [],
		commitsRead: false,
		commitsReason: null,
		review: null,
		reviewRead: false,
		reviewReason: null,
		...partial,
	};
}

describe("a session on a box this window reaches", () => {
	/**
	 * 이 창은 그 상자와 짝을 지었다 — 세션이 거기 간 경로가 그것이다. 그러니
	 * 거절이 아니라 물어보는 것이 정직한 답이다. 터미널은 이미 그렇게 중계된다.
	 */
	it("거절하지 않고 그 상자에 물어본다", async () => {
		const { sent, report, write } = collect();
		const asked: string[] = [];

		await answerHubGitStatus(
			{ request_id: "r", session_id: "hmux-1", want: "commits", intent: "read" as const },
			{
				locate: () => ({ kind: "remote", boxId: "host-1", workspaceId: "workspace_1" }),
				status: async () => repo(),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat(),
				remoteStatus: async (boxId, sessionId, workspaceId, want) => {
					asked.push(`${boxId}/${sessionId}/${workspaceId}/${want}`);
					return boxAnswer({
						commitsRead: true,
						commits: [
							{ short_sha: "1fb0321", subject: "s", author: "a", when: "2 hours ago" },
						],
					});
				},
				report,
				write,
			},
		);

		expect(asked).toEqual(["host-1/hmux-1/workspace_1/commits"]);
		expect(sent[0]?.reply.commits_read).toBe(true);
		expect(sent[0]?.reply.commits).toHaveLength(1);
		expect(sent[0]?.reply.code).toBeUndefined();
	});

	/**
	 * **이 창이 못 닿는 것은 폰도 못 닿는다는 뜻이 아니다.**
	 *
	 * 폰은 `session_elsewhere` 에서만 자기 SSH 로 폴백한다. 그런데 이 창은 폰이
	 * 성공하는 곳에서 실패할 수 있다 — 그 상자가 이 기계의 `known_hosts` 에
	 * 없다든가, 열쇠 재료가 다르다든가. 실패에 다른 코드를 붙이면 그 상자와
	 * 짝지은 폰이 오늘 읽던 것도 못 읽게 된다.
	 */
	it("이 창이 못 물어보면 폰이 직접 물을 수 있게 남겨 둔다", async () => {
		for (const locate of [
			() => ({ kind: "remote" as const }),
			() => ({ kind: "remote" as const, boxId: "host-1" }),
		]) {
			const { sent, report, write } = collect();
			await answerHubGitStatus(
				{ request_id: "r", session_id: "hmux-1", intent: "read" as const },
				{
					locate,
					status: async () => repo(),
					review: async () => ({ kind: "none" as const }),
					createReview: async () => ({ kind: "none" as const }),
					commits: async () => [],
					branches: async () => [],
					commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
					reviewerCandidates: async () => [],
					setReviewers: async () => {},
					diffStat: async () => stat(),
					remoteStatus: async () => {
						throw new Error("this window has no route");
					},
					report,
					write,
				},
			);
			expect(sent[0]?.reply.code).toBe("session_elsewhere");
		}

		// 닿을 수는 있는데 왕복이 실패한 경우도 같다.
		const { sent, report, write } = collect();
		await answerHubGitStatus(
			{ request_id: "r", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "remote", boxId: "host-1", workspaceId: "workspace_1" }),
				status: async () => repo(),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat(),
				remoteStatus: async () => {
					throw new Error("hmux_protocol_version_unsupported: …");
				},
				report,
				write,
			},
		);
		expect(sent[0]?.reply.code).toBe("session_elsewhere");
	});

	/**
	 * 상자가 **답을 준** 실패는 다르다. 폰이 그 상자에 다시 물어봐야 할 이유가
	 * 없다 — 방금 우리를 통해 물어봤고, 그 상자가 이유를 말했다.
	 */
	it("상자가 이유를 말하면 그 이유를 그대로 전한다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "r", session_id: "hmux-1", want: "pull_request", intent: "read" as const },
			{
				locate: () => ({ kind: "remote", boxId: "host-1", workspaceId: "workspace_1" }),
				status: async () => repo(),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat(),
				remoteStatus: async () => boxAnswer({ reviewReason: "not_authenticated" }),
				report,
				write,
			},
		);

		expect(sent[0]?.reply.code).toBe("review_not_authenticated");
		expect(sent[0]?.reply.detail).toBe("gh is not logged in on that box");
		// 브랜치는 살아남는다 — 읽어낸 사실이다.
		expect(sent[0]?.reply.branch).toBe("fix/payment-retry");
	});
});

describe("answerHubGitStatus", () => {
	it("파일과 ±줄 수를 그대로 넘긴다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo(),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () =>
					stat({
						files: [{ path: "src/app.ts", oldPath: null, added: 14, deleted: 3, status: "M" }],
						ahead: 2,
						behind: 0,
					}),
				report,
				write,
			},
		);

		expect(sent[0]).toEqual({
			requestId: "git-status-0",
			reply: {
				files: [{ path: "src/app.ts", status: "M", added: 14, deleted: 3 }],
				files_read: true,
				branch: "fix/payment-retry",
				ahead: 2,
				behind: 0,
				baseRef: "main",
			},
		});
	});

	/**
	 * 이진 파일은 0 줄이 아니라 **모르는** 줄이다. 0 으로 넘기면 폰이 `+0 −0` 을
	 * 그리고, 그건 바뀐 파일을 "안 바뀜" 으로 읽게 한다.
	 */
	it("이진 파일에는 줄 수를 붙이지 않는다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo(),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () =>
					stat({ files: [{ path: "logo.png", oldPath: null, added: null, deleted: null, status: "M" }] }),
				report,
				write,
			},
		);

		expect(sent[0]?.reply.files[0]).toEqual({ path: "logo.png", status: "M" });
	});

	/**
	 * 모르는 세션과 못 읽은 저장소는 사용자에게 다른 조치를 뜻한다 — 앞은 다른
	 * 컴퓨터를 보라는 뜻이고, 뒤는 다시 해보라는 뜻이다.
	 */
	it("모르는 세션은 그렇다고 말한다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "없는-세션", intent: "read" as const },
			{
				locate: () => undefined,
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo(),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => {
					throw new Error("불려서는 안 된다");
				},
				report,
				write,
			},
		);

		expect(sent[0]?.reply.detail).toBe("This computer could not find that session.");
		expect(sent[0]?.reply.files).toEqual([]);
	});

	/** 던지면 기다리는 쪽은 마감까지 회색 화면을 본다. 이유를 돌려준다. */
	it("git 이 실패해도 이유를 돌려준다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo(),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => {
					throw new Error("not a git repository");
				},
				report,
				write,
			},
		);

		expect(sent[0]?.reply.detail).toBe("not a git repository");
	});

	/**
	 * 다른 컴퓨터에서 도는 세션은 **못 찾은** 것이 아니다. 노트북은 그게 뭔지
	 * 정확히 알고, 여기서 `git` 을 못 돌릴 뿐이다 — "못 찾았다" 로 말하면
	 * 사용자는 자기 사이드바에 서 있는 세션을 딴 데서 찾게 된다.
	 */
	it("원격 세션은 못 찾은 것과 다르게 말한다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "remote" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo(),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => {
					throw new Error("불려서는 안 된다");
				},
				report,
				write,
			},
		);

		expect(sent[0]?.reply.detail).toBe(
			"That session is running on another computer, so its changes cannot be read here.",
		);
		// 폰이 문장이 아니라 이 값으로 분기한다: 이 거절은 포기가 아니라 "그
		// 컴퓨터에 직접 물어라" 다. 문구를 다듬는다고 폴백이 사라지면 안 된다.
		expect(sent[0]?.reply.code).toBe("session_elsewhere");
	});

	/** 옮긴 파일은 어디서 왔는지가 그 줄의 전부다. */
	it("이름이 바뀐 파일은 원래 경로를 싣는다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo(),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () =>
					stat({
						files: [
							{
								path: "src/lib/hub/gitStatus.ts",
								oldPath: "src/gitStatus.ts",
								added: 2,
								deleted: 0,
								status: "R",
							},
						],
					}),
				report,
				write,
			},
		);

		expect(sent[0]?.reply.files[0]).toEqual({
			path: "src/lib/hub/gitStatus.ts",
			status: "R",
			old_path: "src/gitStatus.ts",
			added: 2,
			deleted: 0,
		});
	});

	/**
	 * 보고가 실패해도 두 번 보고하지 않는다. 두 번째까지 실패하면 그 거절은
	 * 아무도 안 듣는 곳으로 새어 나간다 — 훅이 `void` 로 부르기 때문이다.
	 */
	it("보고는 한 번뿐이다", async () => {
		let calls = 0;

		await expect(
			answerHubGitStatus(
				{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
				{
					locate: () => ({ kind: "local", worktreePath: "/repo" }),
					remoteStatus: async () => {
						throw new Error("a local session must never ask a box");
					},
					status: async () => repo(),
					review: async () => ({ kind: "none" as const }),
					createReview: async () => ({ kind: "none" as const }),
					commits: async () => [],
					branches: async () => [],
					commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
					reviewerCandidates: async () => [],
					setReviewers: async () => {},
					diffStat: async () => stat(),
					report: async () => {
						calls += 1;
						throw new Error("창이 내려가는 중");
					},
					write: async () => {},
				},
			),
		).rejects.toThrow("창이 내려가는 중");
		expect(calls).toBe(1);
	});

	/**
	 * 브랜치는 배치표(캐시)가 아니라 파일 목록을 읽은 그 순간의 git 에서 온다.
	 * 캐시는 터미널 pane 을 못 담고, 기존 체크아웃에서 만든 에이전트에는 비어
	 * 있고, 나머지는 만든 시각의 스냅샷이다.
	 */
	it("브랜치와 앞뒤 수는 지금 읽은 git 에서 온다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo({ branch: "worktree/card-tokens", ahead: 7, behind: 1 }),
				// diffstat 의 앞뒤 수는 기본 브랜치와의 merge-base 기준이라 노트북
				// 뱃지(upstream 기준)와 다른 숫자다. 이 값이 이기면 두 화면이 서로
				// 다른 "2 ahead" 를 말한다.
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat({ ahead: 40, behind: 0 }),
				report,
				write,
			},
		);

		expect(sent[0]?.reply.branch).toBe("worktree/card-tokens");
		expect(sent[0]?.reply.ahead).toBe(7);
		expect(sent[0]?.reply.behind).toBe(1);
	});

	/** detached HEAD 에는 이름이 없다. 지어내지 않는다. */
	it("detached HEAD 는 브랜치를 안 싣는다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo({ branch: "" }),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat(),
				report,
				write,
			},
		);

		expect(sent[0]?.reply.branch).toBeUndefined();
	});

	/** 저장소가 아니면 앞뒤 수도 없다 — 0 은 "같다" 는 주장이다. */
	it("저장소가 아니면 앞뒤 수를 주장하지 않는다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo({ isRepo: false, branch: "", ahead: 0, behind: 0 }),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat(),
				report,
				write,
			},
		);

		expect(sent[0]?.reply.ahead).toBeUndefined();
		expect(sent[0]?.reply.behind).toBeUndefined();
		expect(sent[0]?.reply.branch).toBeUndefined();
	});

	/**
	 * 두 읽기는 서로 다른 질문이다. diffstat 이 실패했다고 브랜치가 없어지면,
	 * 폰은 방금 읽어낸 브랜치를 들고 있으면서 "아직 받지 못했습니다" 라고 한다.
	 */
	it("파일 목록이 실패해도 브랜치는 살아남는다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo({ branch: "worktree/card-tokens" }),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => {
					throw new Error("기준 ref 를 찾지 못했습니다");
				},
				report,
				write,
			},
		);

		expect(sent[0]?.reply.branch).toBe("worktree/card-tokens");
		expect(sent[0]?.reply.detail).toBe("기준 ref 를 찾지 못했습니다");
	});

	/** 반대쪽도 같다 — 브랜치를 못 읽어도 바뀐 파일은 그대로 보여준다. */
	it("브랜치를 못 읽어도 파일 목록은 살아남는다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => {
					throw new Error("git status 실패");
				},
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () =>
					stat({ files: [{ path: "a.ts", oldPath: null, added: 1, deleted: 0, status: "M" }] }),
				report,
				write,
			},
		);

		expect(sent[0]?.reply.files).toHaveLength(1);
		expect(sent[0]?.reply.detail).toBeUndefined();
		expect(sent[0]?.reply.branch).toBeUndefined();
	});

	/**
	 * 둘 다 못 읽었으면 빈 목록을 내면 안 된다 — 그건 "깨끗함" 으로 그려지고,
	 * 어느 쪽 읽기도 그런 말을 한 적이 없다.
	 */
	it("둘 다 실패하면 깨끗하다고 하지 않는다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => {
					throw new Error("git status 실패");
				},
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat({ files: [] }),
				report,
				write,
			},
		);

		expect(sent[0]?.reply.detail).toBe("git status 실패");
	});

	/**
	 * 커밋 탭은 같은 워크트리에 **다른 질문**을 한다. 파일 목록까지 매번 읽으면
	 * 아무도 안 여는 탭 때문에 탭을 열 때마다 `git log` 를 쓰게 된다.
	 */
	it("커밋 탭은 커밋만 읽는다", async () => {
		const { sent, report, write } = collect();
		let diffStatCalls = 0;

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", want: "commits", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo(),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [
					{
						short_sha: "0c9ca04",
						subject: "feat(hub): keep the hub on",
						author: "kattpish",
						when: "18 minutes ago",
					},
				],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => {
					diffStatCalls += 1;
					return stat();
				},
				report,
				write,
			},
		);

		expect(diffStatCalls).toBe(0);
		expect(sent[0]?.reply.commits).toHaveLength(1);
		expect(sent[0]?.reply.commits?.[0]?.short_sha).toBe("0c9ca04");
		expect(sent[0]?.reply.commits_read).toBe(true);
		// 브랜치 카드는 같은 카드다 — 탭을 바꿔도 그 값은 그대로 있어야 한다.
		expect(sent[0]?.reply.branch).toBe("fix/payment-retry");
	});

	/**
	 * 커밋이 **없다**는 답과, 못 물어봤다는 침묵은 다른 사실이다.
	 *
	 * base 에 그대로 앉은 워크트리가 여기서 가장 흔한 상태다. 빈 목록만 보내면
	 * 폰은 그 정상 상태를 "노트북이 아직 안 보냅니다" 로 그린다 — `review_read`
	 * 가 PR 탭에서 푸는 것과 같은 문제다.
	 */
	it("기준 이후 커밋이 없다는 답을 침묵과 갈라 보낸다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", want: "commits", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo(),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat(),
				report,
				write,
			},
		);

		expect(sent[0]?.reply.commits).toEqual([]);
		expect(sent[0]?.reply.commits_read).toBe(true);
		expect(sent[0]?.reply.detail).toBeUndefined();
		// 이 답은 파일을 읽지 않았다. 폰의 브랜치 카드가 그 빈 목록으로
		// "0 changed" 를 그리면 더러운 워크트리 위에 깨끗하다고 쓰게 된다.
		expect(sent[0]?.reply.files_read).toBeUndefined();
	});

	/** 커밋을 못 읽어도 브랜치는 살아남는다 — 변경 탭과 같은 규칙이다. */
	it("커밋 읽기가 실패해도 브랜치는 남는다", async () => {
		const { sent, report, write } = collect();

		await answerHubGitStatus(
			{ request_id: "git-status-0", session_id: "hmux-1", want: "commits", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo({ branch: "worktree/card-tokens" }),
				review: async () => ({ kind: "none" as const }),
				createReview: async () => ({ kind: "none" as const }),
				commits: async () => {
					throw new Error("기준 ref 를 찾지 못했습니다");
				},
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat(),
				report,
				write,
			},
		);

		expect(sent[0]?.reply.branch).toBe("worktree/card-tokens");
		expect(sent[0]?.reply.detail).toBe("기준 ref 를 찾지 못했습니다");
	});

	/**
	 * "리뷰 없음" 과 "못 물어봄" 은 다른 사실이다. 접으면 gh 로그인이 안 된
	 * 사람에게 "PR 이 없다" 고 말하게 되고, 그 사람은 만들려고 든다.
	 */
	it("리뷰가 없는 것과 못 물어본 것을 갈라 말한다", async () => {
		const none = collect();
		await answerHubGitStatus(
			{ request_id: "r", session_id: "hmux-1", want: "pull_request", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo(),
				review: async () => ({ kind: "none" }),
				createReview: async () => ({ kind: "none" }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat(),
				report: none.report,
				write: none.write,
			},
		);
		expect(none.sent[0]?.reply.review_read).toBe(true);
		expect(none.sent[0]?.reply.review).toBeUndefined();
		expect(none.sent[0]?.reply.detail).toBeUndefined();

		const blocked = collect();
		await answerHubGitStatus(
			{ request_id: "r", session_id: "hmux-1", want: "pull_request", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo(),
				review: async () => ({ kind: "unavailable", reason: "not_authenticated" }),
				createReview: async () => ({ kind: "none" }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat(),
				report: blocked.report,
				write: blocked.write,
			},
		);
		expect(blocked.sent[0]?.reply.review_read).toBeUndefined();
		expect(blocked.sent[0]?.reply.code).toBe("review_not_authenticated");
	});

	/**
	 * 만들기는 폰이 일으키는 유일한 바깥으로 나가는 일이다. 읽기 요청이 그것을
	 * 부르면 탭을 여는 것만으로 리뷰가 생긴다.
	 */
	it("만들기는 요청이 그렇게 말했을 때만 부른다", async () => {
		const { sent, report, write } = collect();
		let created = 0;
		let read = 0;

		await answerHubGitStatus(
			{ request_id: "r", session_id: "hmux-1", want: "pull_request", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo(),
				review: async () => {
					read += 1;
					return { kind: "none" };
				},
				createReview: async () => {
					created += 1;
					return { kind: "none" };
				},
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat(),
				report,
				write,
			},
		);

		expect(created).toBe(0);
		expect(read).toBe(1);
		expect(sent[0]?.reply.review_read).toBe(true);
	});

	/** 브랜치가 없으면 열 리뷰도 없다. gh 를 부르지 않는다. */
	it("브랜치가 없으면 호스트를 부르지 않는다", async () => {
		const { sent, report, write } = collect();
		let asked = 0;

		await answerHubGitStatus(
			{ request_id: "r", session_id: "hmux-1", want: "pull_request", intent: "read" as const },
			{
				locate: () => ({ kind: "local", worktreePath: "/repo" }),
				remoteStatus: async () => {
					throw new Error("a local session must never ask a box");
				},
				status: async () => repo({ branch: "" }),
				review: async () => {
					asked += 1;
					return { kind: "none" };
				},
				createReview: async () => ({ kind: "none" }),
				commits: async () => [],
				branches: async () => [],
				commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
				reviewerCandidates: async () => [],
				setReviewers: async () => {},
				diffStat: async () => stat(),
				report,
				write,
			},
		);

		expect(asked).toBe(0);
		expect(sent[0]?.reply.detail).toBe("No branch, so there is no review to open");
	});
});

describe("a phone that asks for a change", () => {
	const local = {
		locate: () => ({ kind: "local" as const, worktreePath: "/repo" }),
		remoteStatus: async () => {
			throw new Error("a local session must never ask a box");
		},
		status: async () => repo(),
		review: async () => ({ kind: "none" as const }),
		createReview: async () => ({ kind: "none" as const }),
		commits: async () => [],
		branches: async () => [],
		commitDetail: async () => ({ shortSha: "46d1088", body: null, files: [] }),
		reviewerCandidates: async () => [],
		setReviewers: async () => {},
	};

	/**
	 * 답은 바뀐 뒤의 상태다. "보냈다" 로 끝내면 폰이 다시 물어야 하고, 그 사이에
	 * 이 창이 닫혀 있을 수 있다 — 그러면 사람은 성공한 커밋을 못 본 채로 남는다.
	 */
	it("바꾼 뒤의 목록을 그대로 돌려준다", async () => {
		const { sent, written, report, write } = collect();

		await answerHubGitStatus(
			{
				request_id: "git-status-0",
				session_id: "hmux-1",
				intent: "write",
				action_id: "press-1",
				action: { kind: "commit", paths: ["src/app.ts"], message: "fix it" },
			},
			{
				...local,
				diffStat: async () => stat({ files: [], worktreeFiles: [] }),
				report,
				write,
			},
		);

		expect(written).toEqual([
			{
				worktreePath: "/repo",
				action: { kind: "commit", paths: ["src/app.ts"], message: "fix it" },
			},
		]);
		// 그리고 답은 거절이 아니라 읽은 목록이다.
		expect(sent[0]?.reply.detail).toBeUndefined();
		expect(sent[0]?.reply.files_read).toBe(true);
	});

	/**
	 * 백엔드의 문장을 그대로 옮긴다. 여기서 다시 쓰면 "그 파일에 커밋할 게
	 * 없다" 와 "그 브랜치 이름은 git 이 쓰지 않는다" 가 한 문장이 된다.
	 */
	it("거절의 이유를 백엔드가 말한 그대로 싣는다", async () => {
		const { sent, report } = collect();

		await answerHubGitStatus(
			{
				request_id: "git-status-0",
				session_id: "hmux-1",
				intent: "write",
				action_id: "press-1",
				action: { kind: "create_branch", name: "a b" },
			},
			{
				...local,
				diffStat: async () => stat(),
				report,
				write: async () => {
					throw new Error("쓸 수 없는 브랜치 이름입니다");
				},
			},
		);

		expect(sent[0]?.reply.detail).toBe("쓸 수 없는 브랜치 이름입니다");
		expect(sent[0]?.reply.code).toBe("write_failed");
	});

	/**
	 * 다른 상자의 저장소는 여기서 바꿀 수 없다. 이 노트북이 그 상자에 대해
	 * 들고 있는 열쇠도, 폰이 들고 있는 열쇠도 읽기 전용 forced command 다 —
	 * 메울 구멍이 아니라 의도된 경계다.
	 */
	it("다른 상자의 저장소는 바꾸지 않는다", async () => {
		const { sent, written, report, write } = collect();

		await answerHubGitStatus(
			{
				request_id: "git-status-0",
				session_id: "hmux-1",
				intent: "write",
				action_id: "press-1",
				action: { kind: "checkout", branch: "main" },
			},
			{
				...local,
				locate: () => ({ kind: "remote", boxId: "host-1", workspaceId: "w1" }),
				diffStat: async () => stat(),
				report,
				write,
			},
		);

		expect(written).toEqual([]);
		expect(sent[0]?.reply.code).toBe("write_elsewhere");
		// `session_elsewhere` 가 아니다 — 그 코드는 폰에게 "그 상자에 직접
		// 물어라" 라는 뜻이고, 그 길은 쓰기에는 없다.
		expect(sent[0]?.reply.code).not.toBe("session_elsewhere");
	});

	/**
	 * 실패한 쓰기 뒤에 목록을 읽지 않는다. 읽으면 아무것도 안 바뀐 목록이
	 * 성공한 답과 같은 모양으로 돌아가고, 화면은 거절을 못 본다.
	 */
	it("쓰기가 실패하면 목록을 읽지 않는다", async () => {
		const { sent, report } = collect();
		let reads = 0;

		await answerHubGitStatus(
			{
				request_id: "git-status-0",
				session_id: "hmux-1",
				intent: "write",
				action_id: "press-1",
				action: { kind: "discard", paths: ["src/app.ts"] },
			},
			{
				...local,
				diffStat: async () => {
					reads += 1;
					return stat();
				},
				report,
				write: async () => {
					throw new Error("nope");
				},
			},
		);

		expect(reads).toBe(0);
		expect(sent[0]?.reply.detail).toBe("nope");
	});

	/**
	 * 리뷰어는 저장소가 아니라 코드 호스트의 것이라 자기 갈래를 쓴다. 그리고
	 * 답은 바뀐 뒤의 리뷰다 — 폰이 한 번 더 묻지 않아도 되게.
	 */
	it("리뷰어를 바꾸고 바뀐 뒤의 리뷰를 돌려준다", async () => {
		const { sent, report, write } = collect();
		const asked: { number: number; add: string[]; remove: string[] }[] = [];

		await answerHubGitStatus(
			{
				request_id: "git-status-0",
				session_id: "hmux-1",
				want: "pull_request",
				intent: "set_reviewers",
				action_id: "press-1",
				number: 418,
				add: ["jay-hong"],
				remove: ["minseo"],
			},
			{
				...local,
				diffStat: async () => stat(),
				report,
				write,
				setReviewers: async (_path, number, add, remove) => {
					asked.push({ number, add, remove });
				},
			},
		);

		expect(asked).toEqual([{ number: 418, add: ["jay-hong"], remove: ["minseo"] }]);
		// 그리고 답은 거절이 아니라 읽어낸 리뷰 상태다.
		expect(sent[0]?.reply.detail).toBeUndefined();
		expect(sent[0]?.reply.review_read).toBe(true);
	});

	/**
	 * 호스트의 문장 그대로. 다시 쓰면 "권한이 없다" 와 "그런 사람이 없다" 가
	 * 한 문장이 된다. 그리고 실패한 뒤에는 리뷰를 읽지 않는다 — 읽으면 아무것도
	 * 안 바뀐 상태가 성공한 답과 같은 모양으로 돌아간다.
	 */
	it("리뷰어 거절의 이유를 그대로 싣고 리뷰를 읽지 않는다", async () => {
		const { sent, report, write } = collect();
		let reads = 0;

		await answerHubGitStatus(
			{
				request_id: "git-status-0",
				session_id: "hmux-1",
				want: "pull_request",
				intent: "set_reviewers",
				action_id: "press-1",
				number: 418,
				add: ["nobody"],
				remove: [],
			},
			{
				...local,
				diffStat: async () => stat(),
				review: async () => {
					reads += 1;
					return { kind: "none" as const };
				},
				report,
				write,
				setReviewers: async () => {
					throw new Error("그 저장소에 쓸 권한이 없습니다");
				},
			},
		);

		expect(reads).toBe(0);
		expect(sent[0]?.reply.detail).toBe("그 저장소에 쓸 권한이 없습니다");
		expect(sent[0]?.reply.code).toBe("write_failed");
	});

	/**
	 * 빈 목록과 못 물어본 것은 다르다. `null` 을 빈 목록으로 그리면 아무도 없는
	 * 시트가 이유 없이 열린다.
	 */
	it("사람을 못 물어본 것과 아무도 없는 것을 갈라 말한다", async () => {
		const empty = collect();
		await answerHubGitStatus(
			{ request_id: "r", session_id: "hmux-1", want: "reviewers", intent: "read" as const },
			{
				...local,
				diffStat: async () => stat(),
				reviewerCandidates: async () => [],
				report: empty.report,
				write: empty.write,
			},
		);
		expect(empty.sent[0]?.reply.reviewers_read).toBe(true);
		expect(empty.sent[0]?.reply.reviewers).toEqual([]);

		const refused = collect();
		await answerHubGitStatus(
			{ request_id: "r", session_id: "hmux-1", want: "reviewers", intent: "read" as const },
			{
				...local,
				diffStat: async () => stat(),
				reviewerCandidates: async () => null,
				report: refused.report,
				write: refused.write,
			},
		);
		expect(refused.sent[0]?.reply.reviewers_read).toBeUndefined();
		expect(refused.sent[0]?.reply.detail).toBeDefined();
	});

	/**
	 * PR 은 브랜치가 원격에 있어야 존재할 수 있고, `gh pr create --head` 는
	 * 어떤 경우에도 올려 주지 않는다(v2.89.0 소스에서 확인: `--head` 는
	 * `skipPushRefs` 로 모든 push 경로를 건너뛴다). 이 한 줄이 없으면 "만들기"
	 * 는 아무도 올린 적 없는 브랜치 — 에이전트가 방금 만든 브랜치 대부분 —
	 * 에서 서버 오류로 끝난다.
	 */
	it("리뷰를 열기 전에 브랜치를 올린다", async () => {
		const { sent, written, report, write } = collect();

		await answerHubGitStatus(
			{
				request_id: "git-status-0",
				session_id: "hmux-1",
				want: "pull_request",
				intent: "create_review",
				title: "t",
				body: "",
				draft: false,
			},
			{ ...local, diffStat: async () => stat(), report, write },
		);

		expect(written).toEqual([{ worktreePath: "/repo", action: { kind: "push" } }]);
		expect(sent[0]?.reply.review_read).toBe(true);
	});

	/**
	 * 올리지 못했으면 리뷰도 못 연다. 그 이유를 그대로 말하는 편이, `gh` 가
	 * 서버에서 받아 오는 문장보다 사람이 할 일을 알려 준다.
	 */
	it("못 올렸으면 리뷰를 열지 않고 그 이유를 말한다", async () => {
		const { sent, report } = collect();
		let created = 0;

		await answerHubGitStatus(
			{
				request_id: "git-status-0",
				session_id: "hmux-1",
				want: "pull_request",
				intent: "create_review",
				title: "t",
				body: "",
				draft: false,
			},
			{
				...local,
				diffStat: async () => stat(),
				createReview: async () => {
					created += 1;
					return { kind: "none" as const };
				},
				report,
				write: async () => {
					throw new Error("어느 원격으로 올릴지 정해져 있지 않습니다");
				},
			},
		);

		expect(created).toBe(0);
		expect(sent[0]?.reply.detail).toBe("어느 원격으로 올릴지 정해져 있지 않습니다");
		expect(sent[0]?.reply.code).toBe("push_failed");
	});
});
