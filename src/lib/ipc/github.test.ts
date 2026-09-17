import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubIssueDetails } from "@/lib/github/githubIssueDetails";
import { parseGitHubWorkItem } from "@/lib/github/githubResponses";
import {
	ghAssignableUsers,
	ghAuthState,
	ghExec,
	ghIssueDetails,
	ghMutateIssue,
	ghRepository,
	ghWorkItem,
	ghWorkItems,
	ghWorkspaceProjects,
	ghWorkspaceWorkItems,
} from "./github";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

/** Rust ghx::GhExecOut은 serde 기본 snake_case로 넘어온다. */
const raw = (over: Partial<Record<string, unknown>> = {}) => ({
	stdout: "",
	stderr: "",
	code: 0,
	timed_out: false,
	missing: false,
	...over,
});

/** invoke 호출의 args 배열 — 어떤 gh 명령을 만들었는지 본다. */
const lastArgs = (): string[] => {
	const calls = invokeMock.mock.calls;
	const last = calls[calls.length - 1];
	return (last?.[1] as { args?: string[] } | undefined)?.args ?? [];
};

beforeEach(() => {
	invokeMock.mockReset();
});

describe("ghExec", () => {
	it("snake_case 응답을 프런트 표기로 옮긴다", async () => {
		invokeMock.mockResolvedValue(
			raw({ stdout: "out", code: 1, timed_out: true }),
		);
		await expect(ghExec(["auth", "status"])).resolves.toEqual({
			stdout: "out",
			stderr: "",
			code: 1,
			timedOut: true,
			missing: false,
		});
	});

	it("repo·timeout을 주지 않으면 null로 보낸다 — undefined는 Rust에서 인자 누락이 된다", async () => {
		invokeMock.mockResolvedValue(raw());
		await ghExec(["auth", "status"]);
		expect(invokeMock).toHaveBeenCalledWith("gh_exec", {
			repo: null,
			args: ["auth", "status"],
			timeoutMs: null,
		});
	});
});

describe("ghAuthState", () => {
	it("gh가 없으면 미인증과 구분한다", async () => {
		invokeMock.mockResolvedValue(raw({ missing: true }));
		await expect(ghAuthState()).resolves.toEqual({ kind: "missing" });
	});

	/** gh는 버전에 따라 status를 stdout에 쓴 적도 있다 — 한쪽만 보면 로그인한
	 *  사용자가 로그아웃으로 보인다. */
	it("stdout에만 status가 와도 읽는다", async () => {
		invokeMock.mockResolvedValue(
			raw({
				stdout: `github.com
  ✓ Logged in to github.com account u (keyring)
  - Active account: true
  - Token scopes: 'repo', 'read:org'
`,
			}),
		);
		await expect(ghAuthState()).resolves.toMatchObject({ kind: "ready" });
	});
});

describe("ghWorkItems", () => {
	it("PR은 headRefName까지 요청한다 — 그게 없으면 PR 브랜치를 이어받지 못한다", async () => {
		invokeMock.mockResolvedValue(raw({ stdout: "[]" }));
		await ghWorkItems("/repo", "pr", "");
		expect(lastArgs()).toContain("number,title,headRefName");
	});

	it("검색어가 없으면 --search를 붙이지 않는다", async () => {
		invokeMock.mockResolvedValue(raw({ stdout: "[]" }));
		await ghWorkItems("/repo", "issue", "   ");
		expect(lastArgs()).not.toContain("--search");
	});

	it("검색어는 공백을 털어 넘긴다", async () => {
		invokeMock.mockResolvedValue(raw({ stdout: "[]" }));
		await ghWorkItems("/repo", "issue", "  retry  ");
		const args = lastArgs();
		expect(args[args.length - 1]).toBe("retry");
	});

	it("조회가 실패하면 빈 목록 — 다이얼로그를 죽이지 않는다", async () => {
		invokeMock.mockResolvedValue(raw({ code: 1, stderr: "boom" }));
		await expect(ghWorkItems("/repo", "issue", "")).resolves.toEqual([]);
	});
});

describe("ghWorkItem", () => {
	/** `gh view`는 배열이 아니라 객체 하나를 준다 — 감싸지 않으면 파서가 버린다. */
	it("단건 응답을 배열로 감싸 읽는다", async () => {
		invokeMock.mockResolvedValue(
			raw({ stdout: '{"number":12,"title":"Fix retry"}' }),
		);
		await expect(ghWorkItem("/repo", "issue", 12)).resolves.toMatchObject({
			number: 12,
			title: "Fix retry",
			kind: "issue",
		});
	});

	it("없는 번호면 null", async () => {
		invokeMock.mockResolvedValue(raw({ code: 1 }));
		await expect(ghWorkItem("/repo", "issue", 999)).resolves.toBeNull();
	});
});

describe("GitHub workspace queries", () => {
	const repository = {
		projectId: "project-1",
		projectName: "Dure",
		path: "/repo",
		nameWithOwner: "hebbianai/dure",
		owner: "hebbianai",
		url: "https://github.com/hebbianai/dure",
		isInOrganization: true,
	};
	const issue = parseGitHubWorkItem(
		{ number: 42, title: "Issue", url: `${repository.url}/issues/42` },
		"issue",
		repository,
	);
	if (!issue) throw new Error("Invalid issue fixture");
	const readers = [
		[
			"repository",
			() => ghRepository({ id: "project-1", name: "Dure", path: "/repo" }),
		],
		["assignees", () => ghAssignableUsers(repository)],
		["details", () => ghIssueDetails(issue)],
		["work items", () => ghWorkspaceWorkItems(repository, "issue", "open", "")],
		["projects", () => ghWorkspaceProjects(repository, "open", "")],
	] as const;

	it.each(readers)(
		"preserves read failures across %s queries",
		async (_name, read) => {
			for (const [output, kind] of [
				[raw({ code: 1, missing: true }), "missing-cli"],
				[raw({ code: 1, timed_out: true }), "timed-out"],
				[raw({ stdout: "not json" }), "malformed-response"],
			] as const) {
				invokeMock.mockResolvedValueOnce(output);
				await expect(read()).resolves.toEqual({
					ok: false,
					error: { kind, detail: "" },
				});
			}
			invokeMock.mockRejectedValueOnce(new Error("Unavailable"));
			await expect(read()).resolves.toEqual({
				ok: false,
				error: { kind: "command-failed", detail: "Error: Unavailable" },
			});
			expect(invokeMock).toHaveBeenCalledTimes(4);
		},
	);

	it("keeps valid empty lists successful across list and assignment consumers", async () => {
		invokeMock.mockResolvedValue(raw({ stdout: "[]" }));
		await expect(ghAssignableUsers(repository)).resolves.toEqual({
			ok: true,
			value: [],
		});
		await expect(
			ghWorkspaceWorkItems(repository, "issue", "open", ""),
		).resolves.toEqual({ ok: true, value: [], limitReached: false });
		await expect(ghWorkspaceProjects(repository, "open", "")).resolves.toEqual({
			ok: true,
			value: [],
			limitReached: false,
		});
	});

	it("resolves repository identity from the selected checkout", async () => {
		invokeMock.mockResolvedValue(
			raw({
				stdout: JSON.stringify({
					nameWithOwner: "hebbianai/dure",
					owner: { login: "hebbianai" },
					url: repository.url,
					isInOrganization: true,
				}),
			}),
		);
		await expect(
			ghRepository({ id: "project-1", name: "Dure", path: "/repo" }),
		).resolves.toEqual({ ok: true, value: repository });
		expect(lastArgs().slice(0, 2)).toEqual(["repo", "view"]);
	});
	it("loads assignable users across pages from the selected host and repository", async () => {
		invokeMock.mockResolvedValue(
			raw({ stdout: '[[{"login":"dev"}],[{"login":"qa"}]]' }),
		);
		await expect(
			ghAssignableUsers({
				...repository,
				url: "https://github.example/hebbianai/dure",
			}),
		).resolves.toEqual({ ok: true, value: ["dev", "qa"] });
		expect(lastArgs()).toEqual([
			"api",
			"repos/hebbianai/dure/assignees?per_page=100",
			"--hostname",
			"github.example",
			"--paginate",
			"--slurp",
		]);
		expect(invokeMock).toHaveBeenLastCalledWith(
			"gh_exec",
			expect.objectContaining({ repo: repository.path, timeoutMs: 20_000 }),
		);
	});
	it("does not disguise an assignee lookup failure as an empty list", async () => {
		invokeMock.mockResolvedValueOnce(raw({ code: 1, stderr: "Forbidden" }));
		await expect(ghAssignableUsers(repository)).resolves.toMatchObject({
			ok: false,
			error: { kind: "command-failed" },
		});
		invokeMock.mockResolvedValueOnce(raw({ stdout: "null" }));
		await expect(ghAssignableUsers(repository)).resolves.toMatchObject({
			ok: false,
			error: { kind: "malformed-response" },
		});
	});

	it("keeps issue queries free of the optional read:project scope", async () => {
		invokeMock.mockResolvedValue(raw({ stdout: "[]" }));
		await ghWorkspaceWorkItems(repository, "issue", "open", "refresh");
		expect(lastArgs().join(" ")).not.toContain("projectItems");
		expect(lastArgs().slice(-2)).toEqual(["--repo", repository.url]);
		expect(lastArgs()[lastArgs().indexOf("--search") + 1]).toBe("refresh");
		expect(lastArgs()[lastArgs().indexOf("--limit") + 1]).toBe("1000");
	});

	it("classifies project scope failures without collapsing other views", async () => {
		invokeMock.mockResolvedValue(
			raw({ code: 1, stderr: "token missing required scopes [read:project]" }),
		);
		await expect(
			ghWorkspaceProjects(repository, "open", ""),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "project-scope" },
		});
	});

	it.each(["issue", "pr"] as const)(
		"marks a capped %s snapshot instead of claiming an exact total",
		async (kind) => {
			invokeMock.mockResolvedValue(
				raw({
					stdout: JSON.stringify(
						Array.from({ length: 1000 }, (_, index) => ({
							number: index + 1,
							title: `Item ${index}`,
							url: `${repository.url}/${kind === "pr" ? "pull" : "issues"}/${index + 1}`,
						})),
					),
				}),
			);
			const result = await ghWorkspaceWorkItems(repository, kind, "all", "");
			expect(result).toMatchObject({ ok: true, limitReached: true });
			if (result.ok) expect(result.value).toHaveLength(1000);
		},
	);

	it("retains the project cap warning even when the local search matches nothing", async () => {
		invokeMock.mockResolvedValue(
			raw({
				stdout: JSON.stringify({
					projects: Array.from({ length: 1000 }, (_, index) => ({
						number: index + 1,
						title: `Project ${index}`,
						url: `https://github.com/orgs/hebbianai/projects/${index + 1}`,
					})),
				}),
			}),
		);
		await expect(
			ghWorkspaceProjects(repository, "open", "absent"),
		).resolves.toEqual({ ok: true, value: [], limitReached: true });
		expect(lastArgs()[lastArgs().indexOf("--limit") + 1]).toBe("1000");
	});

	it("turns an invoke rejection into a visible query failure", async () => {
		invokeMock.mockRejectedValue(new Error("sidecar unavailable"));
		await expect(
			ghWorkspaceWorkItems(repository, "pr", "open", ""),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "command-failed", detail: "Error: sidecar unavailable" },
		});
	});

	it("does not present malformed list output as an empty result", async () => {
		invokeMock.mockResolvedValue(raw({ stdout: "not json" }));
		await expect(
			ghWorkspaceWorkItems(repository, "issue", "open", ""),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "malformed-response" },
		});
	});
});

describe("GitHub issue detail commands", () => {
	const detail = {
		id: "I_issue42",
		kind: "issue",
		number: 42,
		url: "https://github.example/team/repo/issues/42",
		repository: {
			path: "/local/repo",
			url: "https://github.example/team/repo",
		},
	} as GitHubIssueDetails;

	it("pins a detail read to its selected GitHub repository instead of a mutable checkout remote", async () => {
		invokeMock.mockResolvedValue(
			raw({
				stdout: JSON.stringify({
					id: "I_issue42",
					number: 42,
					title: "Read in app",
					url: detail.url,
					state: "OPEN",
					body: "Body",
					createdAt: "2026-09-07T00:00:00Z",
					comments: [],
				}),
			}),
		);
		await expect(ghIssueDetails(detail)).resolves.toMatchObject({
			ok: true,
			value: { body: "Body" },
		});
		expect(lastArgs().slice(0, 5)).toEqual([
			"issue",
			"view",
			"42",
			"--repo",
			detail.repository.url,
		]);
		expect(lastArgs().join(" ")).not.toContain("projectItems");
	});

	it("returns permission failures and rejected writes without automatic retries", async () => {
		invokeMock.mockResolvedValueOnce(raw({ code: 1, stderr: "Forbidden" }));
		await expect(
			ghMutateIssue(detail, { kind: "state", state: "CLOSED" }),
		).resolves.toMatchObject({ ok: false, error: { detail: "Forbidden" } });
		expect(lastArgs()).toEqual([
			"issue",
			"close",
			"42",
			"--repo",
			detail.repository.url,
			"--reason",
			"completed",
		]);
		invokeMock.mockRejectedValueOnce(new Error("Unavailable"));
		await expect(
			ghMutateIssue(detail, { kind: "comment", body: "Evidence" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "command-failed" } });
		expect(invokeMock).toHaveBeenCalledTimes(2);
	});

	it("resolves a canonical duplicate issue before one atomic close-and-link request on the selected host", async () => {
		invokeMock.mockResolvedValueOnce(
			raw({
				stdout: JSON.stringify({
					id: "I_original77",
					number: 77,
					url: "https://github.example/team/repo/issues/77",
				}),
			}),
		);
		invokeMock.mockResolvedValueOnce(
			raw({
				stdout: JSON.stringify({
					id: detail.id,
					state: "CLOSED",
					stateReason: "DUPLICATE",
				}),
			}),
		);
		await expect(
			ghMutateIssue(detail, { kind: "duplicate", number: 77 }),
		).resolves.toEqual({ ok: true, value: null });
		expect((invokeMock.mock.calls[0][1] as { args: string[] }).args).toEqual([
			"issue",
			"view",
			"77",
			"--repo",
			detail.repository.url,
			"--json",
			"id,number,url",
		]);
		expect(lastArgs()).toEqual([
			"api",
			"graphql",
			"--hostname",
			"github.example",
			"-f",
			expect.stringContaining(
				"stateReason:DUPLICATE,duplicateIssueId:$duplicate",
			),
			"-f",
			"issue=I_issue42",
			"-f",
			"duplicate=I_original77",
			"--jq",
			".data.closeIssue.issue",
		]);
		expect(invokeMock).toHaveBeenCalledTimes(2);
	});
	it.each([42, 0, NaN, -1, 1.5])(
		"refuses an invalid duplicate number before any command: %s",
		async (number) => {
			await expect(
				ghMutateIssue(detail, { kind: "duplicate", number }),
			).resolves.toMatchObject({
				ok: false,
				error: { kind: "invalid-duplicate" },
			});
			expect(invokeMock).not.toHaveBeenCalled();
		},
	);
	it.each([
		{
			id: "I_issue42",
			number: 77,
			url: "https://github.example/team/repo/issues/77",
		},
		{
			id: "PR_77",
			number: 77,
			url: "https://github.example/team/repo/pull/77",
		},
		{
			id: "I_other",
			number: 77,
			url: "https://github.example/other/repo/issues/77",
		},
	])(
		"refuses an untrusted duplicate lookup without a mutation: %j",
		async (target) => {
			invokeMock.mockResolvedValueOnce(raw({ stdout: JSON.stringify(target) }));
			await expect(
				ghMutateIssue(detail, { kind: "duplicate", number: 77 }),
			).resolves.toMatchObject({
				ok: false,
				error: { kind: "invalid-duplicate" },
			});
			expect(invokeMock).toHaveBeenCalledTimes(1);
		},
	);
	it("does not continue a failed duplicate lookup or retry a rejected atomic mutation", async () => {
		invokeMock.mockResolvedValueOnce(
			raw({ code: 1, stderr: "Could not resolve to an Issue" }),
		);
		await expect(
			ghMutateIssue(detail, { kind: "duplicate", number: 77 }),
		).resolves.toMatchObject({ ok: false });
		expect(invokeMock).toHaveBeenCalledTimes(1);
		invokeMock.mockResolvedValueOnce(
			raw({
				stdout: JSON.stringify({
					id: "I_original77",
					number: 77,
					url: "https://github.example/team/repo/issues/77",
				}),
			}),
		);
		invokeMock.mockResolvedValueOnce(
			raw({ code: 1, stderr: "Permission denied" }),
		);
		await expect(
			ghMutateIssue(detail, { kind: "duplicate", number: 77 }),
		).resolves.toMatchObject({
			ok: false,
			error: { detail: "Permission denied" },
		});
		expect(invokeMock).toHaveBeenCalledTimes(3);
	});
	it("does not treat an incomplete close acknowledgement as a confirmed duplicate", async () => {
		invokeMock.mockResolvedValueOnce(
			raw({
				stdout: JSON.stringify({
					id: "I_original77",
					number: 77,
					url: "https://github.example/team/repo/issues/77",
				}),
			}),
		);
		invokeMock.mockResolvedValueOnce(
			raw({ stdout: JSON.stringify({ id: detail.id, state: "OPEN" }) }),
		);
		await expect(
			ghMutateIssue(detail, { kind: "duplicate", number: 77 }),
		).resolves.toMatchObject({
			ok: false,
			error: { kind: "malformed-response" },
		});
	});
});
