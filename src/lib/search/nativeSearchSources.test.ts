import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildCommandHistorySearchCommand,
	buildFileNameSearchCommand,
	parseCommandHistoryOutput,
	parseFileNameSearchOutput,
	searchNativeFiles,
} from "@/lib/search/nativeSearchSources";

describe("native file search source", () => {
	const context = {
		id: "local:/repo",
		label: "Dure",
		root: "/repo's worktree",
		source: "local" as const,
	};

	it("quotes paths and queries while bounding traversal and output", () => {
		const command = buildFileNameSearchCommand(
			context.root,
			"$(touch /tmp/nope)",
			500,
		);
		expect(command).toContain("cd '/repo'\\''s worktree'");
		expect(command).toContain("'$(touch /tmp/nope)'");
		expect(command).toContain("head -n 100");
	});

	it("executes the non-repository fallback and returns only matching files", () => {
		const root = mkdtempSync(join(tmpdir(), "dure-native-search-"));
		try {
			const bin = join(root, "bin");
			mkdirSync(join(root, "src"));
			mkdirSync(join(root, "node_modules"));
			mkdirSync(bin);
			writeFileSync(join(root, "src", "nativeSearch.ts"), "");
			writeFileSync(join(root, "src", "other.ts"), "");
			writeFileSync(join(root, "node_modules", "nativeSearch.js"), "");
			writeFileSync(
				join(bin, "git"),
				[
					"#!/bin/sh",
					"if printenv GIT_DIR >/dev/null 2>&1 || printenv GIT_WORK_TREE >/dev/null 2>&1; then",
					"  echo src/contaminatedNativeSearch.ts",
					"  exit 0",
					"fi",
					"exit 1",
				].join("\n"),
				{ mode: 0o700 },
			);

			const stdout = execFileSync(
				process.platform === "win32" ? "bash.exe" : "/bin/sh",
				["-c", buildFileNameSearchCommand(root, "nativeSearch", 20)],
				{
					encoding: "utf8",
					env: {
						...process.env,
						GIT_DIR: "/contaminated/git-dir",
						GIT_WORK_TREE: "/contaminated/worktree",
						PATH: `${bin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
					},
				},
			);
			expect(stdout.trim()).toBe("./src/nativeSearch.ts");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("turns relative file hits into exact safe-open actions", () => {
		expect(
			parseFileNameSearchOutput(
				context,
				"./src/App.tsx\nsrc/App.tsx\nREADME.md\n",
			),
		).toEqual([
			expect.objectContaining({
				title: "App.tsx",
				action: {
					type: "open-file",
					path: "/repo's worktree/src/App.tsx",
					source: "local",
					hostId: undefined,
				},
			}),
			expect.objectContaining({
				title: "README.md",
				action: expect.objectContaining({ path: "/repo's worktree/README.md" }),
			}),
		]);
	});

	it("ignores a failed context while preserving successful cross-worktree hits", async () => {
		const local = vi
			.fn()
			.mockRejectedValueOnce(new Error("gone"))
			.mockResolvedValueOnce({
				stdout: "src/search.ts\n",
				stderr: "",
				code: 0,
			});
		const results = await searchNativeFiles(
			[context, { ...context, id: "second", root: "/second" }],
			"search",
			{ local, ssh: vi.fn() },
		);
		expect(results).toHaveLength(1);
		expect(results[0].action).toMatchObject({ path: "/second/src/search.ts" });
	});
});

describe("native command history source", () => {
	it("builds a read-only bounded history query", () => {
		const command = buildCommandHistorySearchCommand("git $(unsafe)", 200);
		expect(command).toContain('tail -n 2500 "$file"');
		expect(command).toContain("'git $(unsafe)'");
		expect(command).toContain("tail -n 100");
	});

	it("normalizes zsh, bash, and fish records, newest first, without executing them", () => {
		const items = parseCommandHistoryOutput(
			{ id: "local", label: "Local", source: "local" },
			[
				": 1720000000:0;pnpm test",
				"#1720000001",
				"git status",
				"- cmd: cargo test",
				"  when: 1720000002",
				"git status",
			].join("\n"),
		);
		expect(items.map(({ title }) => title)).toEqual([
			"git status",
			"cargo test",
			"pnpm test",
		]);
		expect(items[0].action).toEqual({
			type: "copy-command",
			command: "git status",
		});
	});
});
