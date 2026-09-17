import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import {
	mergeProjectSearchResults,
	searchLocalProjects,
} from "./localProjectSearch";

beforeEach(() => mocks.invoke.mockReset());

describe("local project search", () => {
	it("omits a directory that disappeared after discovery", async () => {
		mocks.invoke.mockResolvedValueOnce(["/removed"]).mockResolvedValueOnce([
			{ schemaVersion: 1, absentPath: "/removed" },
		]);
		expect(await searchLocalProjects("removed")).toEqual([]);
	});
	it("finds repositories without conversation history and folds linked checkouts", async () => {
		mocks.invoke.mockImplementation(async (command: string) =>
			command === "search_local_directories"
				? ["/notes", "/repo/.worktrees/task", "/repo"]
				: [
						null,
						{
							schemaVersion: 1,
							canonicalPath: "/repo/.worktrees/task",
							gitCommonDir: "/repo/.git",
						},
						{
							schemaVersion: 1,
							canonicalPath: "/repo",
							gitCommonDir: "/repo/.git",
						},
					],
		);
		const results = await searchLocalProjects("repo");
		expect(
			results.map(({ path, isRepo, sessionCount }) => ({
				path,
				isRepo,
				sessionCount,
			})),
		).toEqual([
			{ path: "/repo", isRepo: true, sessionCount: 0 },
			{ path: "/notes", isRepo: false, sessionCount: 0 },
		]);
		expect(mocks.invoke).toHaveBeenCalledWith("search_local_directories", {
			query: "repo",
		});
	});

	it("does not invoke Git with an empty batch and preserves search failures", async () => {
		mocks.invoke.mockResolvedValueOnce([]);
		expect(await searchLocalProjects("missing")).toEqual([]);
		expect(mocks.invoke).toHaveBeenCalledTimes(1);
		mocks.invoke.mockRejectedValueOnce(new Error("search unavailable"));
		await expect(searchLocalProjects("repo")).rejects.toThrow(
			"search unavailable",
		);
	});

	it("merges history counts without duplicating or recommending registered locations", () => {
		const repository = {
			path: "/repo",
			name: "repo",
			isRepo: true,
			sessionCount: 0,
			lastMtime: 0,
		};
		const recent = { ...repository, sessionCount: 3, lastMtime: 30 };
		expect(mergeProjectSearchResults([recent], [repository], [])).toEqual([
			recent,
		]);
		expect(
			mergeProjectSearchResults([recent], [repository], ["/repo/"]),
		).toEqual([]);
	});
});
