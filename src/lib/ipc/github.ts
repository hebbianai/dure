// ipc/github — GitHub CLI(`gh`) 호출.
//
// 인증은 gh가 전부 맡는다(자체 토큰 보관 없음, 소유자 결정 2026-08-02).
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).
// 출력 파싱은 src/lib/github/gh.ts의 순수 함수가 맡는다.

import { invoke } from "@tauri-apps/api/core";
import {
	authState,
	type GhAuthState,
	type GhWorkItem,
	parseAuthStatus,
	parseWorkItems,
} from "@/lib/github/gh";
import { parseGitHubAssignableUsers } from "@/lib/github/githubAssignees";
import {
	type GitHubIssueDetails,
	type GitHubIssueMutation,
	githubCloseDuplicateArgs,
	githubIssueMutationArgs,
	githubIssueTarget,
	ISSUE_DETAIL_FIELDS,
	parseDuplicateIssueNumber,
	parseGitHubIssueDetails,
	parseGitHubIssueIdentity,
} from "@/lib/github/githubIssueDetails";
import { GITHUB_RESULT_LIMIT } from "@/lib/github/githubPagination";
import type {
	GitHubListResult,
	GitHubQueryFailure,
	GitHubQueryResult,
} from "@/lib/github/githubQuery";
import {
	type GitHubProjectRow,
	type GitHubRepository,
	type GitHubWorkItemRow,
	parseGitHubProjectRows,
	parseGitHubRepository,
	parseGitHubWorkItemRows,
} from "@/lib/github/githubResponses";
import {
	filterGitHubProjects,
	type GitHubWorkspacePreset,
	githubProjectListArgs,
	githubProjectScopeMissing,
	githubWorkItemListArgs,
	sortGitHubWorkItems,
} from "@/lib/github/githubWorkspace";
import type { Project } from "@/types";

export interface GhExecOut {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
	missing: boolean;
}

/** Rust ghx::GhExecOut(serde 기본 snake_case) → 프런트 표기. */
interface RawGhExecOut {
	stdout: string;
	stderr: string;
	code: number;
	timed_out: boolean;
	missing: boolean;
}

export const ghExec = async (
	args: string[],
	opts: { repo?: string; timeoutMs?: number } = {},
): Promise<GhExecOut> => {
	const raw = await invoke<RawGhExecOut>("gh_exec", {
		repo: opts.repo ?? null,
		args,
		timeoutMs: opts.timeoutMs ?? null,
	});
	return {
		stdout: raw.stdout,
		stderr: raw.stderr,
		code: raw.code,
		timedOut: raw.timed_out,
		missing: raw.missing,
	};
};

/** 지금 gh가 쓸 수 있는 상태인지. 화면은 이 값 하나로 안내를 고른다. */
export const ghAuthState = async (): Promise<GhAuthState> => {
	const out = await ghExec(["auth", "status"], { timeoutMs: 8000 });
	if (out.missing) return { kind: "missing" };
	// gh는 기본적으로 stderr에 쓰지만 버전에 따라 stdout을 쓴 적도 있어 둘을 합친다.
	return authState(parseAuthStatus(`${out.stdout}\n${out.stderr}`), false);
};

/** 레포의 열린 이슈/PR 목록. 조회 실패는 빈 목록 — 다이얼로그를 죽이지 않는다. */
export const ghWorkItems = async (
	repo: string,
	kind: "issue" | "pr",
	query: string,
	limit = 20,
): Promise<GhWorkItem[]> => {
	const fields = kind === "pr" ? "number,title,headRefName" : "number,title";
	const args = [kind, "list", "--json", fields, "--limit", String(limit)];
	if (query.trim()) args.push("--search", query.trim());
	const out = await ghExec(args, { repo, timeoutMs: 15000 });
	if (out.code !== 0) return [];
	return parseWorkItems(out.stdout, kind);
};

/** 번호 하나를 직접 조회 — `#1234`나 URL을 붙여 넣은 경우. */
export const ghWorkItem = async (
	repo: string,
	kind: "issue" | "pr",
	number: number,
): Promise<GhWorkItem | null> => {
	const fields = kind === "pr" ? "number,title,headRefName" : "number,title";
	const out = await ghExec([kind, "view", String(number), "--json", fields], {
		repo,
		timeoutMs: 15000,
	});
	if (out.code !== 0) return null;
	return parseWorkItems(`[${out.stdout}]`, kind)[0] ?? null;
};

function queryFailure(out: GhExecOut): GitHubQueryFailure {
	if (out.missing) return { kind: "missing-cli", detail: "" };
	if (out.timedOut) return { kind: "timed-out", detail: "" };
	const detail = `${out.stderr}\n${out.stdout}`.trim().slice(0, 800);
	return {
		kind: githubProjectScopeMissing(detail)
			? "project-scope"
			: "command-failed",
		detail,
	};
}

function rejectedQuery(cause: unknown): GitHubQueryFailure {
	return {
		kind: "command-failed",
		detail: String(cause).trim().slice(0, 800),
	};
}

/** Read commands share transport and decoding failures; writes retain their own acknowledgement policy. */
async function readGitHubQuery<T>(
	execute: () => Promise<GhExecOut>,
	decode: (stdout: string) => T | null,
): Promise<GitHubQueryResult<T>> {
	try {
		const out = await execute();
		if (out.code !== 0) return { ok: false, error: queryFailure(out) };
		const value = decode(out.stdout);
		return value === null
			? { ok: false, error: { kind: "malformed-response", detail: "" } }
			: { ok: true, value };
	} catch (cause) {
		return { ok: false, error: rejectedQuery(cause) };
	}
}

export async function ghAssignableUsers(
	repository: GitHubRepository,
): Promise<GitHubQueryResult<string[]>> {
	return readGitHubQuery(
		() =>
			ghExec(
				[
					"api",
					`repos/${repository.nameWithOwner}/assignees?per_page=100`,
					"--hostname",
					new URL(repository.url).hostname,
					"--paginate",
					"--slurp",
				],
				{ repo: repository.path, timeoutMs: 20_000 },
			),
		parseGitHubAssignableUsers,
	);
}

export async function ghIssueDetails(
	row: GitHubWorkItemRow,
): Promise<GitHubQueryResult<GitHubIssueDetails>> {
	return readGitHubQuery(
		() =>
			ghExec(
				[
					"issue",
					"view",
					...githubIssueTarget(row),
					"--json",
					ISSUE_DETAIL_FIELDS,
				],
				{ repo: row.repository.path, timeoutMs: 20_000 },
			),
		(stdout) => parseGitHubIssueDetails(stdout, row),
	);
}

export async function ghMutateIssue(
	row: GitHubIssueDetails,
	mutation: GitHubIssueMutation,
): Promise<GitHubQueryResult<null>> {
	if (mutation.kind === "duplicate")
		return ghCloseDuplicateIssue(row, mutation.number);
	const args = githubIssueMutationArgs(row, mutation);
	if (!args) return { ok: true, value: null };
	try {
		const out = await ghExec(args, {
			repo: row.repository.path,
			timeoutMs: 20_000,
		});
		return out.code === 0
			? { ok: true, value: null }
			: { ok: false, error: queryFailure(out) };
	} catch (cause) {
		return { ok: false, error: rejectedQuery(cause) };
	}
}

async function ghCloseDuplicateIssue(
	row: GitHubIssueDetails,
	number: number,
): Promise<GitHubQueryResult<null>> {
	if (parseDuplicateIssueNumber(String(number), row.number) === null) {
		return { ok: false, error: { kind: "invalid-duplicate", detail: "" } };
	}
	try {
		const target = { number, url: `${row.repository.url}/issues/${number}` };
		const lookup = await ghExec(
			[
				"issue",
				"view",
				String(number),
				"--repo",
				row.repository.url,
				"--json",
				"id,number,url",
			],
			{ repo: row.repository.path, timeoutMs: 20_000 },
		);
		if (lookup.code !== 0) return { ok: false, error: queryFailure(lookup) };
		const identity = parseGitHubIssueIdentity(
			JSON.parse(lookup.stdout),
			target,
		);
		if (!identity || identity.id === row.id)
			return { ok: false, error: { kind: "invalid-duplicate", detail: "" } };
		const out = await ghExec(githubCloseDuplicateArgs(row, identity.id), {
			repo: row.repository.path,
			timeoutMs: 20_000,
		});
		if (out.code !== 0) return { ok: false, error: queryFailure(out) };
		const confirmation = JSON.parse(out.stdout);
		return confirmation?.id === row.id &&
			confirmation.state === "CLOSED" &&
			confirmation.stateReason === "DUPLICATE"
			? { ok: true, value: null }
			: { ok: false, error: { kind: "malformed-response", detail: "" } };
	} catch (cause) {
		return { ok: false, error: rejectedQuery(cause) };
	}
}

/** Resolve a registered local checkout to GitHub's canonical repository identity. */
export async function ghRepository(
	project: Pick<Project, "id" | "name" | "path">,
): Promise<GitHubQueryResult<GitHubRepository>> {
	return readGitHubQuery(
		() =>
			ghExec(
				["repo", "view", "--json", "nameWithOwner,url,owner,isInOrganization"],
				{ repo: project.path, timeoutMs: 12_000 },
			),
		(stdout) => parseGitHubRepository(stdout, project),
	);
}

export async function ghWorkspaceWorkItems(
	repository: GitHubRepository,
	kind: "issue" | "pr",
	preset: GitHubWorkspacePreset,
	query: string,
): Promise<GitHubListResult<GitHubWorkItemRow>> {
	const result = await readGitHubQuery(
		() =>
			ghExec(
				[
					...githubWorkItemListArgs(kind, preset, query, GITHUB_RESULT_LIMIT),
					"--repo",
					repository.url,
				],
				{ repo: repository.path, timeoutMs: 20_000 },
			),
		(stdout) => parseGitHubWorkItemRows(stdout, kind, repository),
	);
	return result.ok
		? {
				ok: true,
				value: sortGitHubWorkItems(result.value),
				limitReached: result.value.length >= GITHUB_RESULT_LIMIT,
			}
		: result;
}

export async function ghWorkspaceProjects(
	repository: GitHubRepository,
	preset: GitHubWorkspacePreset,
	query: string,
): Promise<GitHubListResult<GitHubProjectRow>> {
	const result = await readGitHubQuery(
		() =>
			ghExec(
				githubProjectListArgs(repository.owner, preset, GITHUB_RESULT_LIMIT),
				{ repo: repository.path, timeoutMs: 20_000 },
			),
		(stdout) => parseGitHubProjectRows(stdout, repository.owner),
	);
	return result.ok
		? {
				ok: true,
				value: filterGitHubProjects(result.value, preset, query),
				limitReached: result.value.length >= GITHUB_RESULT_LIMIT,
			}
		: result;
}
