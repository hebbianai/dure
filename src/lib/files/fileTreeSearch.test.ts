import { describe, expect, it } from "vitest";
import {
	buildFileTreeSearchCommand,
	FILE_TREE_SEARCH_LIMIT,
	parseFileTreeSearchResults,
} from "@/lib/files/fileTreeSearch";

describe("fileTreeSearch", () => {
	it("reuses the bounded safe filename-search command", () => {
		const command = buildFileTreeSearchCommand(
			"/repo's worktree",
			"src $(touch /tmp/nope)",
		);

		expect(command).toContain("cd '/repo'\\''s worktree'");
		expect(command).toContain("'src $(touch /tmp/nope)'");
		expect(command).toContain(`head -n ${FILE_TREE_SEARCH_LIMIT}`);
	});

	it("ranks basename matches and returns exact paths", () => {
		expect(
			parseFileTreeSearchResults(
				"/repo/",
				"app",
				"src/application.ts\nsrc/App.tsx\nexamples/my-app.ts\n",
			),
		).toEqual([
			{
				name: "App.tsx",
				path: "/repo/src/App.tsx",
				relativePath: "src/App.tsx",
			},
			{
				name: "application.ts",
				path: "/repo/src/application.ts",
				relativePath: "src/application.ts",
			},
			{
				name: "my-app.ts",
				path: "/repo/examples/my-app.ts",
				relativePath: "examples/my-app.ts",
			},
		]);
	});

	it("deduplicates results, rejects traversal, and keeps the result set bounded", () => {
		const lines = [
			"../outside.ts",
			"/absolute.ts",
			"src/file-0.ts",
			"src/file-0.ts",
			...Array.from({ length: 150 }, (_, index) => `src/file-${index + 1}.ts`),
		];
		const results = parseFileTreeSearchResults(
			"/repo",
			"file",
			lines.join("\n"),
		);

		expect(results).toHaveLength(FILE_TREE_SEARCH_LIMIT);
		expect(results.every(({ path }) => path.startsWith("/repo/"))).toBe(true);
		expect(
			results.filter(({ path }) => path.endsWith("file-0.ts")),
		).toHaveLength(1);
	});
});
