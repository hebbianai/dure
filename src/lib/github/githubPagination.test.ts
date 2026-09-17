import { describe, expect, it } from "vitest";
import {
	githubPage,
	githubPageNumbers,
	reconcileGitHubPage,
} from "./githubPagination";

describe("GitHub pagination", () => {
	it("retains a pending refresh, remembers shrinkage and resets only when the query scope changes", () => {
		let selection = { scope: "repo-1:issues", page: 4 };
		selection = reconcileGitHubPage(selection, selection.scope, null);
		expect(selection.page).toBe(4);
		selection = reconcileGitHubPage(selection, selection.scope, 30);
		expect(selection.page).toBe(2);
		selection = reconcileGitHubPage(selection, selection.scope, null);
		selection = reconcileGitHubPage(selection, selection.scope, 100);
		expect(selection.page).toBe(2);
		selection = reconcileGitHubPage(selection, "repo-2:issues", null);
		expect(selection).toEqual({ scope: "repo-2:issues", page: 1 });
		expect(
			reconcileGitHubPage({ ...selection, page: 2 }, selection.scope, 0).page,
		).toBe(1);
	});
	it("covers every row once across pages, including a short last page", () => {
		const visited = Array.from({ length: 4 }, (_, index) =>
			githubPage(76, index + 1),
		).flatMap((range) =>
			Array.from(
				{ length: range.end - range.start },
				(_, offset) => range.start + offset,
			),
		);
		expect(visited).toEqual(Array.from({ length: 76 }, (_, index) => index));
	});
	it("clamps refresh shrinkage, empty results and first-page boundaries", () => {
		expect(githubPage(30, 4)).toEqual({
			page: 2,
			pageCount: 2,
			start: 25,
			end: 30,
		});
		expect(githubPage(0, 4)).toEqual({
			page: 1,
			pageCount: 1,
			start: 0,
			end: 0,
		});
		expect(githubPage(100, -1).page).toBe(1);
	});
	it("keeps the current page and both endpoints accessible within seven slots", () => {
		for (let total = 1; total <= 80; total++)
			for (let current = 1; current <= total; current++) {
				const pages = githubPageNumbers(current, total);
				expect(pages.length).toBeLessThanOrEqual(7);
				expect(pages).toContain(1);
				expect(pages).toContain(total);
				expect(pages).toContain(current);
				expect(new Set(pages).size).toBe(pages.length);
			}
	});
});
