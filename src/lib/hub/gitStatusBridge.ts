/**
 * Answering a phone that asked what a session changed.
 *
 * The host cannot answer this itself. The phone sends an hmux session id, and
 * the table that turns one into a worktree path lives here — agents, projects
 * and spaces are this app's concepts, not hmux's. A second copy of that mapping
 * in Rust would, on the day the two drift, show the phone another repository's
 * changes on a screen that looks entirely correct.
 *
 * So this module is the mapping and nothing else: session id → location →
 * diffstat. It takes its dependencies as arguments so the mapping can be tested
 * without a repository, a window, or a phone.
 */

import type { AgentDiffStat, DiffFileStat } from "@/lib/ipc/diffReview";
import { t } from "@/lib/i18n";
import type { GitStatus } from "@/types";

/**
 * What the phone actually asked for.
 *
 * One tagged union rather than a bag of optional fields: `create?` used to
 * carry "open a review", and every write added after it would have been
 * another optional beside it — a shape where two of them being set at once is
 * representable and nothing says what that means.
 */
type HubGitStatusIntent =
	| { intent: "read" }
	/**
	 * The one thing in this file that leaves the laptop. Three values and no
	 * argv: the branch and the repository come from the worktree, which the
	 * phone never names — it names a session.
	 */
	| { intent: "create_review"; title: string; body: string; draft: boolean }
	/**
	 * Change the repository. What may be changed is a closed set, and the
	 * argv for each is fixed in `scm_write.rs` — the phone chooses among what
	 * the repository offered and names nothing else.
	 */
	| { intent: "write"; action_id: string; action: SourceControlAction }
	/**
	 * What one commit did — the message body and the files it touched.
	 *
	 * Its own intent rather than a `want`, because the status request's shape is
	 * the promise that it names no revision, and the changes tab still leans on
	 * that promise.
	 */
	| { intent: "commit_detail"; commit: string }
	/**
	 * Change who is asked to review.
	 *
	 * Its own intent rather than a `SourceControlAction`, because that enum is
	 * about the repository and this is about the code host — and because what
	 * the screen must do afterwards differs: changing the repository makes a
	 * file selection meaningless, and changing reviewers does not touch it.
	 */
	| { intent: "set_reviewers"; action_id: string; number: number; add: string[]; remove: string[] };

/** Every repository change a phone may ask for. Mirrors the protocol enum. */
export type SourceControlAction =
	| { kind: "commit"; paths: string[]; message: string }
	| { kind: "discard"; paths: string[] }
	| { kind: "checkout"; branch: string }
	| { kind: "create_branch"; name: string }
	/** Publish this branch to its remote. Never forced — see `scm_write.rs`. */
	| { kind: "push" };

/** What the host hands over when a phone asks. */
export type HubGitStatusDispatch = {
	request_id: string;
	session_id: string;
	/** Which tab asked. Absent means the changed files — the tab that opens first. */
	want?: "changes" | "commits" | "pull_request" | "branches" | "reviewers";
} & HubGitStatusIntent;

/** A review on the branch, as the host reports it. */
interface HubGitReview {
	number: number;
	title: string;
	state: string;
	url: string;
	is_draft: boolean;
	base_ref: string;
	/** The logins with a review requested. Teams are not here. */
	requested_reviewers: string[];
	/** The host's verdict. Empty means nobody has looked yet. */
	review_decision: string;
	/**
	 * How the host's checks stand.
	 *
	 * Absent is "could not ask", not "there are none": a repository without CI
	 * answers with a zero-length run, and folding the two together says "no
	 * checks" about a question that never went out.
	 */
	checks?: { total: number; passed: number; failed: number; pending: number };
}

/** Somebody who could be asked to review. */
interface HubGitReviewer {
	login: string;
	name: string;
}

/** One branch, as the switcher draws it. */
interface HubGitBranch {
	name: string;
	current: boolean;
	checked_out_at?: string;
	when?: string;
}

/** One commit, as the phone draws it. */
interface HubGitCommit {
	short_sha: string;
	subject: string;
	author: string;
	when: string;
}

/**
 * One changed file, in the shape the wire carries.
 *
 * `old_path` keeps the protocol's own field name: this object is handed to a
 * Tauri command that deserializes it straight into `GitFileChange`, and serde
 * matches by the declared name.
 */
interface HubGitFile {
	path: string;
	status: string;
	old_path?: string;
	added?: number;
	deleted?: number;
	/**
	 * This file has changes that are not committed yet.
	 *
	 * Absent means nobody compared against HEAD — the list itself is measured
	 * against the base branch, so a file committed on this branch stays in it.
	 * Folding absent into false would grey out every row on a laptop that did
	 * not answer; folding it into true would let somebody select a file with
	 * nothing to commit, and `git commit --only` refuses the whole selection.
	 */
	uncommitted?: boolean;
}

export interface HubGitStatusReply {
	files: HubGitFile[];
	/** The branch this worktree is on right now. */
	branch?: string;
	ahead?: number;
	behind?: number;
	baseRef?: string;
	/**
	 * The changed-file list was actually read.
	 *
	 * Only the changes tab reads it. Without this, the phone's branch card draws
	 * "0 changed" over a dirty worktree whenever the commits or pull-request tab
	 * is open, because those answers legitimately carry an empty list.
	 */
	files_read?: boolean;
	/** Commits since the base ref. Only when the commits tab asked. */
	commits?: HubGitCommit[];
	/**
	 * The worktree was asked and answered. True with an empty `commits` means
	 * "nothing since the base ref" — which must not read as "could not ask",
	 * since a worktree sitting at its base is the common state here.
	 */
	commits_read?: boolean;
	/** People who could review. Only when the reviewer sheet asked. */
	reviewers?: HubGitReviewer[];
	/**
	 * The host was asked and answered. An empty list with this true means
	 * nobody else has committed here — a real state in a new repository, and
	 * a different one from "this laptop cannot ask".
	 */
	reviewers_read?: boolean;
	/** The branches in this repository. Only when the switcher asked. */
	branches?: HubGitBranch[];
	/**
	 * The worktree was asked and answered. A repository always has at least one
	 * branch, so an empty list here is not the state this flag exists for — it
	 * exists so "this laptop does not send branches yet" is a different answer
	 * from "there are none".
	 */
	branches_read?: boolean;
	/**
	 * One commit's message body. Only when the commit detail asked, and only
	 * when there is one — a commit with no body is common, and an empty string
	 * would leave the screen unable to tell that apart from "not read yet".
	 */
	commit_body?: string;
	/** The review on this branch, when there is one. */
	review?: HubGitReview;
	/**
	 * The host was asked and answered. True with no `review` means "no review
	 * yet" — which must not read as "could not ask", since one is the state the
	 * create button exists for and the other is a login problem.
	 */
	review_read?: boolean;
	/** Present only when the answer failed. The phone prints it as written. */
	detail?: string;
	/**
	 * The kind of refusal, for a caller that must branch rather than print.
	 *
	 * `session_elsewhere` means this window knows the session and cannot read
	 * it — the phone should ask that computer directly instead of giving up.
	 */
	code?: string;
}

/**
 * Where a session runs, as far as this window knows.
 *
 * `remote` is not a failure to find it — the laptop knows exactly which session
 * it is, and knows it cannot read that repository, because `agent_diff_stat`
 * runs `git` here. Telling somebody "그 세션을 못 찾았다" for a session standing
 * in their own sidebar sends them looking at the wrong computer.
 */
export type SessionLocation =
	| { readonly kind: "local"; readonly worktreePath: string }
	/**
	 * The session runs on a box this window reaches over SSH.
	 *
	 * `boxId` is the id this window published in its own sidebar layout, which
	 * is what the backend resolves the host from — taking it from anywhere else
	 * resolves to nothing and silently degrades every remote read back to a
	 * refusal. `workspaceId` is the one the runtime binding recorded when the
	 * session was created there; this window never invents either.
	 *
	 * Absent when the session is remote and this window has no host record for
	 * it — then there is genuinely nothing to ask, and the phone is told to try
	 * that box itself.
	 */
	| {
			readonly kind: "remote";
			readonly boxId?: string;
			readonly workspaceId?: string;
	  };

export interface HubGitStatusDeps {
	/** Where this session runs, or `undefined` if this window has no such session. */
	readonly locate: (sessionId: string) => SessionLocation | undefined;
	/**
	 * git's own answer for this worktree, read now.
	 *
	 * The branch and the ahead/behind counts come from here rather than from the
	 * pushed layout or from `agent_diff_stat`. The layout is a cache keyed on
	 * agent id — it holds nothing for a terminal pane, nothing for an agent made
	 * in an existing checkout, and a creation-time snapshot for the rest. And
	 * `agent_diff_stat` counts against the default branch's merge-base while the
	 * laptop's own badge counts against the upstream, so taking the counts from
	 * there would print two different "2 ahead"s on two screens the user reads
	 * side by side.
	 */
	readonly status: (worktreePath: string) => Promise<GitStatus>;
	/** The diffstat for a worktree. */
	readonly diffStat: (worktreePath: string) => Promise<AgentDiffStat>;
	/**
	 * The commits since the base ref.
	 *
	 * Read only when the commits tab asks. Reading it every time would spend a
	 * `git log` on a tab most people never open, on every tap.
	 */
	readonly commits: (worktreePath: string) => Promise<HubGitCommit[]>;
	/** The review on this branch. Only when the pull request tab asks. */
	readonly review: (worktreePath: string, branch: string) => Promise<ForgeReviewAnswer>;
	/** Open a review. Only when the phone asked for one. */
	readonly createReview: (
		worktreePath: string,
		branch: string,
		draft: { title: string; body: string; draft: boolean },
	) => Promise<ForgeReviewAnswer>;
	/**
	 * Change the repository.
	 *
	 * One dependency for the whole closed set rather than four: the backend
	 * already branches on the action, and splitting it here would put the same
	 * `match` in two places.
	 *
	 * Rejects with the backend's own sentence — "no uncommitted changes in one
	 * of those files" and "that branch name is not writable" are different
	 * errands, and only the side standing next to the repository knows which.
	 */
	readonly write: (worktreePath: string, action: SourceControlAction) => Promise<unknown>;
	/**
	 * The branches in this repository.
	 *
	 * Read only when the switcher asks. Unlike the file list, this moves only
	 * on a checkout — so it is not worth a `for-each-ref` on every tap of the
	 * screen, and the sheet is the one moment somebody wants it.
	 */
	readonly branches: (worktreePath: string) => Promise<HubGitBranch[]>;
	/**
	 * People who could be asked to review, most recently worked with first.
	 *
	 * `null` is "could not ask" — a different answer from an empty list, which
	 * is a repository nobody else has committed to.
	 */
	readonly reviewerCandidates: (worktreePath: string) => Promise<HubGitReviewer[] | null>;
	/**
	 * Change who is asked to review, by delta.
	 *
	 * Rejects with the host's own sentence. The delta rather than a set is the
	 * host's own command shape, and it is what keeps a team this screen never
	 * listed from being removed by it.
	 */
	readonly setReviewers: (
		worktreePath: string,
		number: number,
		add: string[],
		remove: string[],
	) => Promise<unknown>;
	/**
	 * What one commit did. Rejects with the reader's own sentence — "that sha
	 * is not a commit here" and "this is not a repository" are different
	 * errands.
	 */
	readonly commitDetail: (
		worktreePath: string,
		commit: string,
	) => Promise<{ shortSha: string; body: string | null; files: DiffFileStat[] }>;
	/**
	 * Ask a box this window reaches over SSH about one of its sessions.
	 *
	 * The session is on another machine, but this window is paired with it — it
	 * is how the session got there — so the honest answer is to ask rather than
	 * to refuse. Rejects when this window cannot reach that box, which is a
	 * different fact from the box saying no; see `replyFor`.
	 */
	readonly remoteStatus: (
		boxId: string,
		sessionId: string,
		workspaceId: string,
		want: HubGitStatusDispatch["want"],
	) => Promise<RemoteGitStatus>;
	/** Hand the answer back to the round trip that is waiting for it. */
	readonly report: (requestId: string, reply: HubGitStatusReply) => Promise<unknown>;
}

/** What a box answered about one of its sessions. Mirrors the Tauri command. */
export interface RemoteGitStatus {
	kind: "read" | "not_versioned" | "unavailable";
	reason: string | null;
	branch: string | null;
	ahead: number | null;
	behind: number | null;
	baseRef: string | null;
	files: HubGitFile[];
	filesRead: boolean;
	commits: HubGitCommit[];
	commitsRead: boolean;
	commitsReason: string | null;
	review: HubGitReview | null;
	reviewRead: boolean;
	reviewReason: string | null;
}

/** What the backend answers about a branch's review. */
export type ForgeReviewAnswer =
	| { kind: "open"; review: HubGitReview }
	| { kind: "none" }
	| { kind: "unavailable"; reason: string };

/**
 * A binary file has no line counts — not zero.
 *
 * `null` from the backend means "this is binary"; forwarding it as 0 would make
 * the phone draw `+0 −0`, which reads as "nothing changed" for a file that did.
 */
function fileOf(stat: DiffFileStat, uncommitted: ReadonlySet<string> | undefined): HubGitFile {
	return {
		path: stat.path,
		status: stat.status,
		// A rename's source is the half that says what moved and from where.
		...(stat.oldPath === null ? {} : { old_path: stat.oldPath }),
		...(stat.added === null ? {} : { added: stat.added }),
		...(stat.deleted === null ? {} : { deleted: stat.deleted }),
		// Absent when this backend never split committed work from local WIP.
		// `?? []` here would turn that silence into "nothing to commit" on every
		// row, and the phone would grey out a worktree full of edits.
		...(uncommitted === undefined ? {} : { uncommitted: uncommitted.has(stat.path) }),
	};
}

/** The reply for one request. Never throws — see [`answerHubGitStatus`]. */
/**
 * Answer for a session running on a box this window reaches over SSH.
 *
 * # Why every failure here is still `session_elsewhere`
 *
 * The phone falls back to its own SSH connection on exactly that code. This
 * window can fail where the phone succeeds — the box may be absent from *this*
 * machine's `known_hosts`, and the key material is this machine's, not the
 * phone's. Minting a different code for a failure would close a road that works
 * today for a phone paired with that box. Only an answer the box actually
 * produced may say anything else.
 */
async function remoteReply(
	sessionId: string,
	location: Extract<SessionLocation, { kind: "remote" }>,
	want: HubGitStatusDispatch["want"],
	deps: HubGitStatusDeps,
): Promise<HubGitStatusReply> {
	const elsewhere: HubGitStatusReply = {
		files: [],
		detail: t("sessions.hubGitStatus.remoteUnavailable"),
		// A code rather than the sentence, so rewording the sentence cannot
		// silently remove the phone's fallback.
		code: "session_elsewhere",
	};
	// No host record, or a session created before the binding recorded its
	// workspace: there is genuinely nothing to ask with.
	if (location.boxId === undefined || location.workspaceId === undefined) return elsewhere;

	let answer: RemoteGitStatus;
	try {
		answer = await deps.remoteStatus(location.boxId, sessionId, location.workspaceId, want);
	} catch {
		return elsewhere;
	}
	if (answer.kind === "not_versioned") {
		return { files: [], detail: t("sessions.hubGitStatus.remote.not_versioned") };
	}
	if (answer.kind === "unavailable") {
		// The box answered, and said why. That is not the phone's cue to try the
		// box itself — it just did, through us.
		return {
			files: [],
			...(answer.branch ? { branch: answer.branch } : {}),
			detail: t(`sessions.hubGitStatus.remote.${answer.reason ?? "failed"}`),
			code: `remote_${answer.reason ?? "failed"}`,
		};
	}
	const facts = {
		...(answer.branch ? { branch: answer.branch } : {}),
		...(answer.ahead === null ? {} : { ahead: answer.ahead }),
		...(answer.behind === null ? {} : { behind: answer.behind }),
		...(answer.baseRef ? { baseRef: answer.baseRef } : {}),
	};
	if (answer.commitsReason !== null) {
		return { files: [], ...facts, detail: t(`sessions.hubGitStatus.remote.${answer.commitsReason}`), code: `commits_${answer.commitsReason}` };
	}
	if (answer.reviewReason !== null) {
		return { files: [], ...facts, detail: t(`sessions.hubGitStatus.remote.${answer.reviewReason}`), code: `review_${answer.reviewReason}` };
	}
	return {
		files: answer.files,
		...facts,
		...(answer.filesRead ? { files_read: true } : {}),
		...(answer.commitsRead ? { commits: answer.commits, commits_read: true } : {}),
		...(answer.reviewRead ? { review_read: true } : {}),
		...(answer.review === null ? {} : { review: answer.review }),
	};
}

async function replyFor(
	dispatch: HubGitStatusDispatch,
	deps: HubGitStatusDeps,
): Promise<HubGitStatusReply> {
	const sessionId = dispatch.session_id;
	const want = dispatch.want;
	const location = deps.locate(sessionId);
	if (location === undefined) {
		return { files: [], detail: t("sessions.hubGitStatus.sessionMissing") };
	}
	if (dispatch.intent === "write") {
		// A repository on another box cannot be written to from here. The key
		// this laptop holds for it is a read-only forced command, and the phone's
		// own key is too — which is deliberate, not a gap to fill later.
		if (location.kind === "remote") {
			return { files: [], detail: t("sessions.hubScmWrite.remote"), code: "write_elsewhere" };
		}
		try {
			await deps.write(location.worktreePath, dispatch.action);
		} catch (error) {
			// The backend's own sentence. Rewriting it here would erase the
			// difference between "nothing uncommitted in that file" and "that
			// branch name is not one git will write".
			return { files: [], detail: reasonOf(error), code: "write_failed" };
		}
		// The answer is the state the repository is now in, read the same way
		// the changes tab reads it — so the phone does not have to ask again
		// through a window that may have closed in between.
	}
	if (dispatch.intent === "set_reviewers") {
		if (location.kind === "remote") {
			return { files: [], detail: t("sessions.hubScmWrite.remote"), code: "write_elsewhere" };
		}
		try {
			await deps.setReviewers(
				location.worktreePath,
				dispatch.number,
				dispatch.add,
				dispatch.remove,
			);
		} catch (error) {
			return { files: [], detail: reasonOf(error), code: "write_failed" };
		}
		// Falls through to the pull-request read below, so the answer is the
		// review as it now stands rather than a receipt the phone would have to
		// follow with a second question.
	}
	if (dispatch.intent === "commit_detail") {
		if (location.kind === "remote") {
			// 그 상자의 게이트웨이는 이 질문을 아직 모른다. 커밋 목록은 답하므로
			// 여기까지 올 수 있고, 그 사실을 그대로 말하는 편이 낫다.
			return {
				files: [],
				detail: t("sessions.hubCommitDetail.remote"),
				code: "commit_detail_elsewhere",
			};
		}
		let detail: Awaited<ReturnType<HubGitStatusDeps["commitDetail"]>>;
		try {
			detail = await deps.commitDetail(location.worktreePath, dispatch.commit);
		} catch (error) {
			return { files: [], detail: reasonOf(error) };
		}
		// 그 커밋 안에서는 전부 커밋된 것이다 — 고를 수 있는 줄이 아니다.
		return {
			files: detail.files.map((file) => fileOf(file, new Set())),
			files_read: true,
			...(detail.body === null ? {} : { commit_body: detail.body }),
		};
	}
	if (location.kind === "remote") {
		return await remoteReply(sessionId, location, want, deps);
	}
	// Two reads, together in time but independent in outcome. Asking git twice
	// about one worktree is cheap and bounded by taps on a phone; showing a
	// branch from one moment beside a file list from another is not.
	//
	// `allSettled`, not `all`: they answer different questions. A diffstat that
	// cannot resolve a base ref says nothing about which branch HEAD is on, and
	// letting it erase the branch is how the phone ends up saying "브랜치를 아직
	// 받지 못했습니다" about a worktree whose branch was read successfully one
	// line earlier.
	// The pull request tab, and the one write in this file.
	//
	// The branch is required for both: `gh` works on a branch, and the worktree
	// alone does not name one. A worktree with no branch (detached HEAD) has no
	// review to speak of and cannot be given one.
	if (want === "pull_request") {
		const status = await deps.status(location.worktreePath).catch(() => undefined);
		const branch = status?.isRepo ? status.branch.trim() : "";
		const facts = {
			...(branch ? { branch } : {}),
			...(status?.isRepo ? { ahead: status.ahead, behind: status.behind } : {}),
		};
		if (!branch) {
			return { files: [], ...facts, detail: t("sessions.hubGitStatus.reviewNoBranch") };
		}
		if (dispatch.intent === "create_review") {
			// A pull request cannot exist without the branch on the remote, so
			// publishing it is part of what opening one means — `gh` does exactly
			// this when it can prompt, and it *cannot* do it otherwise: `--head`
			// opts out of every push path in `gh pr create`, so without this the
			// button simply fails on any branch nobody has pushed. Which is most
			// of them, for a branch an agent just made.
			try {
				await deps.write(location.worktreePath, { kind: "push" });
			} catch (error) {
				return { files: [], ...facts, detail: reasonOf(error), code: "push_failed" };
			}
		}
		const answer =
			dispatch.intent === "create_review"
				? await deps.createReview(location.worktreePath, branch, {
						title: dispatch.title,
						body: dispatch.body,
						draft: dispatch.draft,
					})
				: await deps.review(location.worktreePath, branch);
		if (answer.kind === "unavailable") {
			return {
				files: [],
				...facts,
				detail: t(`sessions.hubGitStatus.review.${answer.reason}`),
				code: `review_${answer.reason}`,
			};
		}
		return {
			files: [],
			...facts,
			review_read: true,
			...(answer.kind === "open" ? { review: answer.review } : {}),
		};
	}
	if (want === "reviewers") {
		const [status, reviewers] = await Promise.allSettled([
			deps.status(location.worktreePath),
			deps.reviewerCandidates(location.worktreePath),
		]);
		const repo = status.status === "fulfilled" && status.value.isRepo ? status.value : undefined;
		const facts = {
			...(repo?.branch.trim() ? { branch: repo.branch.trim() } : {}),
			...(repo === undefined ? {} : { ahead: repo.ahead, behind: repo.behind }),
		};
		if (reviewers.status === "rejected") {
			return { files: [], ...facts, detail: reasonOf(reviewers.reason) };
		}
		// `null` is the host refusing, not an empty repository. Reporting it as
		// an empty list would offer a picker with nobody in it and no reason.
		if (reviewers.value === null) {
			return { files: [], ...facts, detail: t("sessions.hubReviewers.unavailable") };
		}
		return { files: [], ...facts, reviewers: reviewers.value, reviewers_read: true };
	}
	if (want === "branches") {
		const [status, branches] = await Promise.allSettled([
			deps.status(location.worktreePath),
			deps.branches(location.worktreePath),
		]);
		const repo = status.status === "fulfilled" && status.value.isRepo ? status.value : undefined;
		const facts = {
			...(repo?.branch.trim() ? { branch: repo.branch.trim() } : {}),
			...(repo === undefined ? {} : { ahead: repo.ahead, behind: repo.behind }),
		};
		if (branches.status === "rejected") {
			return { files: [], ...facts, detail: reasonOf(branches.reason) };
		}
		return { files: [], ...facts, branches: branches.value, branches_read: true };
	}
	// The commits tab asks a different question of the same worktree, and the
	// branch card above it is the same card — so the branch read stays, and only
	// the second read changes.
	if (want === "commits") {
		const [status, commits] = await Promise.allSettled([
			deps.status(location.worktreePath),
			deps.commits(location.worktreePath),
		]);
		const repo = status.status === "fulfilled" && status.value.isRepo ? status.value : undefined;
		const facts = {
			...(repo?.branch.trim() ? { branch: repo.branch.trim() } : {}),
			...(repo === undefined ? {} : { ahead: repo.ahead, behind: repo.behind }),
		};
		if (commits.status === "rejected") {
			return { files: [], ...facts, detail: reasonOf(commits.reason) };
		}
		// `commits_read` 는 목록이 비어도 참이다 — 물어봤고, 없다는 답을 얻었다.
		// 길이로 가르면 base 에 그대로 앉은 워크트리가 폰에서 "아직 안 보냅니다"
		// 로 보인다. `review_read` 가 PR 탭에서 푸는 것과 같은 문제다.
		return { files: [], commits: commits.value, commits_read: true, ...facts };
	}
	const [status, stat] = await Promise.allSettled([
		deps.status(location.worktreePath),
		deps.diffStat(location.worktreePath),
	]);

	const repo = status.status === "fulfilled" && status.value.isRepo ? status.value : undefined;
	const branchFacts = {
		// A detached HEAD reports no branch name. Absent is the honest answer;
		// the phone draws nothing rather than a made-up ref.
		...(repo?.branch.trim() ? { branch: repo.branch.trim() } : {}),
		...(repo === undefined ? {} : { ahead: repo.ahead, behind: repo.behind }),
	};

	if (stat.status === "rejected") {
		return { files: [], ...branchFacts, detail: reasonOf(stat.reason) };
	}
	if (status.status === "rejected" && stat.value.files.length === 0) {
		// Nothing was read at all. An empty list here would be drawn as "clean",
		// which is a claim neither read supports.
		return { files: [], detail: reasonOf(status.reason) };
	}
	// Which of those files still have something to commit. The list itself is
	// measured against the base branch, so a file committed on this branch is
	// still in it — and offering to commit that file would fail the whole
	// selection (`scm_write.rs` admits paths against this same comparison).
	//
	// `undefined` when this backend does not split the two, which is a third
	// answer and not "none": see `fileOf`.
	const worktreeFiles = stat.value.worktreeFiles;
	const uncommitted =
		worktreeFiles === undefined
			? undefined
			: new Set(worktreeFiles.map((file) => file.path));
	return {
		files: stat.value.files.map((file) => fileOf(file, uncommitted)),
		// Only this tab reads the file list, so only this answer may claim a
		// count. The commits and pull-request answers carry an empty list because
		// they did not ask — and the branch card must not read that as "clean".
		files_read: true,
		...branchFacts,
		...(stat.value.baseRef ? { baseRef: stat.value.baseRef } : {}),
	};
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Answer one request.
 *
 * Every failure becomes a refusal with a sentence rather than a throw: the
 * round trip on the other side is waiting, and a thrown error would leave the
 * phone staring at a spinner until the deadline. "This window does not know
 * that session", "it runs elsewhere" and "git could not be read" are different
 * things to a person, so they are different sentences.
 *
 * The report happens once, outside the work. Reporting inside the `try` would
 * mean a failing report is followed by a second report for the same request id
 * — and if that one fails too, the rejection escapes into the caller's `void`.
 */
export async function answerHubGitStatus(
	dispatch: HubGitStatusDispatch,
	deps: HubGitStatusDeps,
): Promise<void> {
	await deps.report(
		dispatch.request_id,
		await replyFor(dispatch, deps),
	);
}
