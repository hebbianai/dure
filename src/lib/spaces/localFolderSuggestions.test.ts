import { describe, expect, it } from "vitest";
import type { ProviderConversationRecord } from "@/lib/agents/providerConversationDiscovery";
import { localFolderSuggestions } from "@/lib/spaces/localFolderSuggestions";

function record(
	overrides: Partial<ProviderConversationRecord> & { cwd: string },
): ProviderConversationRecord {
	return {
		provider: "codex",
		id: `id-${overrides.cwd}-${overrides.mtime ?? 0}`,
		title: "session",
		mtime: 100,
		resumeCapability: "exact",
		executionLocation: "local",
		...overrides,
	};
}

describe("localFolderSuggestions", () => {
	it("recommends one repository for its main checkout and linked worktrees", () => {
		const records = [
			record({
				cwd: "/repo",
				repositoryRoot: "/repo",
				repositoryCommonDir: "/repo/.git",
				mtime: 10,
			}),
			record({
				cwd: "/repo/.worktrees/design/src",
				repositoryRoot: "/repo/.worktrees/design",
				repositoryCommonDir: "/repo/.git",
				mtime: 30,
			}),
			record({
				cwd: "/elsewhere/task",
				repositoryRoot: "/elsewhere/task",
				repositoryCommonDir: "/repo/.git",
				mtime: 20,
			}),
		];
		expect(localFolderSuggestions({ records, registeredPaths: [] })).toEqual([
			expect.objectContaining({
				path: "/repo",
				sessionCount: 3,
				lastMtime: 30,
			}),
		]);
		expect(
			localFolderSuggestions({ records, registeredPaths: ["/repo/"] }),
		).toEqual([]);
		expect(
			localFolderSuggestions({
				records: records.slice(1),
				registeredPaths: [],
			}),
		).toEqual([expect.objectContaining({ path: "/repo", sessionCount: 2 })]);
	});

	it("puts repositories before more recent ordinary folders before limiting", () => {
		expect(
			localFolderSuggestions({
				records: [
					record({ cwd: "/Downloads", mtime: 100 }),
					record({ cwd: "/repo", repositoryRoot: "/repo", mtime: 1 }),
				],
				registeredPaths: [],
				limit: 1,
			}).map((suggestion) => suggestion.path),
		).toEqual(["/repo"]);
	});

	it("collapses sessions onto their repository root and counts them", () => {
		const suggestions = localFolderSuggestions({
			records: [
				record({ cwd: "/repo/sub", repositoryRoot: "/repo", mtime: 10 }),
				record({ cwd: "/repo/other", repositoryRoot: "/repo", mtime: 30 }),
				record({ cwd: "/loose", mtime: 20 }),
			],
			registeredPaths: [],
		});

		expect(suggestions).toEqual([
			{
				path: "/repo",
				name: "repo",
				isRepo: true,
				sessionCount: 2,
				lastMtime: 30,
			},
			{
				path: "/loose",
				name: "loose",
				isRepo: false,
				sessionCount: 1,
				lastMtime: 20,
			},
		]);
	});

	it("never suggests a folder that is already registered", () => {
		const suggestions = localFolderSuggestions({
			records: [
				record({ cwd: "/repo", mtime: 10 }),
				record({ cwd: "/other", mtime: 5 }),
			],
			// 후행 슬래시 차이로 같은 폴더가 다시 제안되면 안 된다.
			registeredPaths: ["/repo/"],
		});

		expect(suggestions.map((s) => s.path)).toEqual(["/other"]);
	});

	it("ignores remote sessions and unusable paths", () => {
		const suggestions = localFolderSuggestions({
			records: [
				record({ cwd: "/remote", executionLocation: "ssh", hostId: "dev" }),
				record({ cwd: "/" }),
				record({ cwd: "   " }),
				record({ cwd: "/keep" }),
			],
			registeredPaths: [],
		});

		expect(suggestions.map((s) => s.path)).toEqual(["/keep"]);
	});

	it("filters by path or folder name and keeps the newest first", () => {
		const records = [
			record({ cwd: "/Users/me/work/alpha", mtime: 10 }),
			record({ cwd: "/Users/me/work/beta", mtime: 50 }),
			record({ cwd: "/Users/me/side/gamma", mtime: 30 }),
		];

		expect(
			localFolderSuggestions({
				records,
				registeredPaths: [],
				query: "work",
			}).map((s) => s.path),
		).toEqual(["/Users/me/work/beta", "/Users/me/work/alpha"]);
		expect(
			localFolderSuggestions({
				records,
				registeredPaths: [],
				query: "GAMMA",
			}).map((s) => s.name),
		).toEqual(["gamma"]);
	});

	it("bounds the list so one busy machine cannot flood the dialog", () => {
		const records = Array.from({ length: 40 }, (_, index) =>
			record({ cwd: `/repo-${index}`, mtime: index }),
		);

		expect(
			localFolderSuggestions({ records, registeredPaths: [] }),
		).toHaveLength(12);
		expect(
			localFolderSuggestions({ records, registeredPaths: [], limit: 3 }).map(
				(s) => s.path,
			),
		).toEqual(["/repo-39", "/repo-38", "/repo-37"]);
	});
});
