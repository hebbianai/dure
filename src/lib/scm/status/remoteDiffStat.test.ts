import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withoutLocalGitOverrides } from "../../../../scripts/lib/git-environment.mjs";
import { badgeFromStat } from "./diffBadges";
import { parseRemoteDiffStat, remoteDiffStatCommand } from "./remoteDiffStat";

/** Frames one numstat view the way the remote script does. */
function section(name: string, tokens: readonly string[]): string {
	return `@${name} ${tokens.length}\n${tokens.map((token) => `${token}\0`).join("")}`;
}

describe("parseRemoteDiffStat", () => {
	it.each(["        ", "\t"])("accepts wc count padding %j without changing numstat paths", (padding) => {
		const stat = parseRemoteDiffStat(
			`base main\nmerge-base abc\nab 0\t0\n@committed${padding}0\n@worktree${padding}1\n1\t0\tspace in path\0@files${padding}1\n1\t0\tspace in path\0`,
		);
		expect(stat.worktreeFiles).toEqual([
			{ path: "space in path", oldPath: null, added: 1, deleted: 0, status: "M" },
		]);
		expect(stat.files).toEqual(stat.worktreeFiles);
	});

	it("reads the header and the three NUL-framed numstat views", () => {
		const stat = parseRemoteDiffStat(
			`base origin/main\nmerge-base abc123\nab 2\t5\n${section("committed", [
				"3\t1\tsrc/a.ts",
				"-\t-\tassets/logo.png",
			])}${section("worktree", [
				"1\t0\t",
				"src/old/b.ts",
				"src/new/b.ts",
				"0\t2\tnotes => todo.md",
			])}${section("files", ["4\t1\tsrc/a.ts"])}`,
		);
		expect(stat.baseRef).toBe("origin/main");
		expect(stat.mergeBase).toBe("abc123");
		expect(stat.ahead).toBe(2);
		expect(stat.behind).toBe(5);
		expect(stat.committedFiles).toEqual([
			{ path: "src/a.ts", oldPath: null, added: 3, deleted: 1, status: "M" },
			{
				path: "assets/logo.png",
				oldPath: null,
				added: null,
				deleted: null,
				status: "M",
			},
		]);
		// Renames travel as three tokens; a literal " => " in a name is a name.
		expect(stat.worktreeFiles).toEqual([
			{
				path: "src/new/b.ts",
				oldPath: "src/old/b.ts",
				added: 1,
				deleted: 0,
				status: "R",
			},
			{
				path: "notes => todo.md",
				oldPath: null,
				added: 0,
				deleted: 2,
				status: "M",
			},
		]);
		expect(stat.files).toHaveLength(1);
		expect(badgeFromStat(stat)).toMatchObject({
			committed: { files: 2, added: 3, deleted: 1, binary: 1 },
			worktree: { files: 2, added: 1, deleted: 2, binary: 0 },
			ahead: 2,
			behind: 5,
		});
	});

	it("keeps a path that looks like a section header inside its section", () => {
		const stat = parseRemoteDiffStat(
			`base main\nmerge-base abc\nab 0\t0\n${section("committed", [])}${section(
				"worktree",
				["1\t0\t@files 9"],
			)}${section("files", ["1\t0\t@files 9"])}`,
		);
		expect(stat.worktreeFiles?.map((file) => file.path)).toEqual(["@files 9"]);
		expect(stat.files).toHaveLength(1);
	});

	it("rejects a truncated stream instead of reporting an all-clear badge", () => {
		expect(() =>
			parseRemoteDiffStat(
				`base main\nmerge-base abc\nab 0\t0\n${section("committed", [])}`,
			),
		).toThrow(/Incomplete/);
		expect(() => parseRemoteDiffStat("")).toThrow(/Incomplete/);
		expect(() =>
			parseRemoteDiffStat(
				"base main\nmerge-base abc\nab 0\t0\n@worktree 2\n1\t0\ta\0",
			),
		).toThrow(/Incomplete/);
		expect(() =>
			parseRemoteDiffStat(
				`base main\nmerge-base abc\nab x\t0\n${section("committed", [])}${section(
					"worktree",
					[],
				)}${section("files", [])}`,
			),
		).toThrow(/divergence/);
	});
});

describe("remoteDiffStatCommand", () => {
	const repos: string[] = [];
	afterEach(() => {
		for (const repo of repos.splice(0))
			rmSync(repo, { recursive: true, force: true });
	});

	// Inherited GIT_DIR / GIT_INDEX_FILE pointers must never reach the fixture
	// or the script under test; both would otherwise touch the caller's checkout.
	const environment = withoutLocalGitOverrides();

	function git(cwd: string, ...args: string[]) {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	function runScript(dir: string) {
		return execFileSync("sh", ["-c", remoteDiffStatCommand(dir)], {
			encoding: "utf8",
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	function repo(): string {
		const dir = mkdtempSync(join(tmpdir(), "dure-remote-diff-stat-"));
		repos.push(dir);
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.email", "qa@example.com");
		git(dir, "config", "user.name", "QA");
		git(dir, "config", "commit.gpgsign", "false");
		writeFileSync(join(dir, "a.txt"), "one\n");
		git(dir, "add", "a.txt");
		git(dir, "commit", "-q", "-m", "base");
		return dir;
	}

	it("quotes the worktree path instead of splicing it into the script", () => {
		const command = remoteDiffStatCommand("/srv/it's here");
		expect(command.endsWith(" dure-diff-stat '/srv/it'\\''s here'")).toBe(true);
		expect(command.startsWith("sh -c '")).toBe(true);
	});

	it("observes the same fork-point statistics as the local command", () => {
		const dir = repo();
		git(dir, "checkout", "-q", "-b", "feature");
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
		git(dir, "commit", "-q", "-am", "committed work");
		// The base moves on so the branch is behind by one commit.
		git(dir, "checkout", "-q", "main");
		writeFileSync(join(dir, "main-only.txt"), "main\n");
		git(dir, "add", "main-only.txt");
		git(dir, "commit", "-q", "-m", "main moves");
		git(dir, "checkout", "-q", "feature");
		// Working tree: one tracked edit, one untracked file and a staged rename.
		writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
		writeFileSync(join(dir, "untracked.txt"), "new\nfile\n");
		writeFileSync(join(dir, "renamed src.txt"), "keep\n".repeat(20));
		git(dir, "add", "renamed src.txt");
		git(dir, "commit", "-q", "-m", "add rename source");
		git(dir, "mv", "renamed src.txt", "renamed dst.txt");

		const stat = parseRemoteDiffStat(runScript(dir));

		expect(stat.baseRef).toBe("main");
		expect(stat.mergeBase).toBe(
			git(dir, "merge-base", "main", "feature").trim(),
		);
		expect(badgeFromStat(stat)).toMatchObject({
			committed: { files: 2, added: 21, deleted: 0 },
			worktree: { files: 3, added: 3, deleted: 0 },
			ahead: 2,
			behind: 1,
		});
		expect(
			stat.worktreeFiles?.find((file) => file.status === "R"),
		).toMatchObject({ path: "renamed dst.txt", oldPath: "renamed src.txt" });
		expect(stat.files.map((file) => file.path).sort()).toEqual([
			"a.txt",
			"renamed dst.txt",
			"untracked.txt",
		]);
		// Observing must not touch the real index: the untracked file stays
		// untracked and the rename stays exactly as staged.
		expect(git(dir, "status", "--porcelain")).toBe(
			' M a.txt\nR  "renamed src.txt" -> "renamed dst.txt"\n?? untracked.txt\n',
		);
	});

	it("fails closed when the worktree has no base branch", () => {
		const dir = mkdtempSync(join(tmpdir(), "dure-remote-diff-stat-"));
		repos.push(dir);
		git(dir, "init", "-q", "-b", "topic");
		git(dir, "config", "user.email", "qa@example.com");
		git(dir, "config", "user.name", "QA");
		git(dir, "config", "commit.gpgsign", "false");
		writeFileSync(join(dir, "a.txt"), "one\n");
		git(dir, "add", "a.txt");
		git(dir, "commit", "-q", "-m", "base");
		expect(() => runScript(dir)).toThrow(/base branch/);
	});
});
