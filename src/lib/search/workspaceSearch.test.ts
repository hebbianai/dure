import { describe, expect, it } from "vitest";
import {
	buildWorkspaceReplaceCommand,
	buildWorkspaceSearchCommand,
	buildWorkspaceSearchMarkdown,
	MAX_WORKSPACE_SEARCH_LINES,
	parseWorkspaceSearchOutput,
} from "./workspaceSearch";

describe("workspace search command", () => {
	it("quotes dynamic values and applies search flags and comma-separated globs", () => {
		const command = buildWorkspaceSearchCommand({
			cwd: "/repo's worktree",
			query: "$(touch /tmp/nope)",
			caseSensitive: false,
			wholeWord: true,
			includeGlob: "*.ts, *.tsx",
			excludeGlob: "dist *, generated",
		});

		expect(command).toContain("cd '/repo'\\''s worktree'");
		expect(command).toContain("command grep -RInF -i -w");
		expect(command).toContain(
			"--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.worktrees --exclude-dir=.claude-worktrees",
		);
		expect(command).toContain("--include='*.ts' --include='*.tsx'");
		expect(command).toContain(
			"--exclude='dist *' --exclude-dir='dist *' --exclude='generated' --exclude-dir='generated'",
		);
		expect(command).toContain("-e '$(touch /tmp/nope)' .");
		expect(command).toContain("command grep -vE '^\\./([^:]*/)?\\.'");
		expect(command.endsWith(`head -n ${MAX_WORKSPACE_SEARCH_LINES + 1}`)).toBe(
			true,
		);
	});

	it("omits optional grep flags when exact substring matching is selected", () => {
		const command = buildWorkspaceSearchCommand({
			cwd: "/repo",
			query: "Needle",
			caseSensitive: true,
			wholeWord: false,
			includeGlob: "",
			excludeGlob: "",
		});

		expect(command).toContain("command grep -RInF --exclude-dir=.git");
		expect(command).not.toContain(" -i ");
		expect(command).not.toContain(" -w ");
	});
});

describe("workspace search output", () => {
	it("groups first-seen files, trims previews, and reports bounded output", () => {
		const longPreview = `  ${"x".repeat(305)}  `;
		const stdout = [
			`./src/first.ts:7:${longPreview}`,
			...Array.from(
				{ length: MAX_WORKSPACE_SEARCH_LINES },
				(_, index) => `./src/second.ts:${index + 1}: hit ${index + 1}`,
			),
		].join("\n");

		const result = parseWorkspaceSearchOutput(stdout);

		expect(result.truncated).toBe(true);
		expect(result.groups.map(({ file }) => file)).toEqual([
			"src/first.ts",
			"src/second.ts",
		]);
		expect(result.groups[0].matches).toEqual([
			{ line: 7, text: "x".repeat(300) },
		]);
		expect(result.groups[1].matches).toHaveLength(
			MAX_WORKSPACE_SEARCH_LINES - 1,
		);
	});
});

describe("workspace replacement command", () => {
	it("builds a case-insensitive literal replacement for the matched files", () => {
		const command = buildWorkspaceReplaceCommand({
			cwd: "/repo's worktree",
			query: "old.value",
			replacement: "new$value",
			caseSensitive: false,
			wholeWord: false,
			preserveCase: false,
			files: ["src/a b.ts", "src/o'hara.ts"],
		});

		expect(command).toContain("cd '/repo'\\''s worktree'");
		expect(command).toContain("'s{old\\.value}{new\\$value}gi'");
		expect(command.endsWith("-- './src/a b.ts' './src/o'\\''hara.ts'")).toBe(
			true,
		);
	});

	it("builds the preserve-case program with whole-word boundaries", () => {
		const command = buildWorkspaceReplaceCommand({
			cwd: "/repo",
			query: "old",
			replacement: 'new"$@',
			caseSensitive: true,
			wholeWord: true,
			preserveCase: true,
			files: ["src/a.ts"],
		});

		expect(command).toContain("s{(\\bold\\b)}");
		expect(command).toContain('pc($1, "new\\"\\$\\@")');
		expect(command).toContain("}ge'");
	});
});

describe("workspace search report", () => {
	it("serializes groups in their displayed order", () => {
		expect(
			buildWorkspaceSearchMarkdown({
				title: "Search",
				query: "needle",
				cwd: "/repo",
				groups: [
					{ file: "src/a.ts", matches: [{ line: 7, text: "first" }] },
					{ file: "README.md", matches: [{ line: 9, text: "second" }] },
				],
			}),
		).toBe(
			'# Search: "needle" — /repo\n\n## src/a.ts\n- 7: first\n\n## README.md\n- 9: second\n',
		);
	});
});
