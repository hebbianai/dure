import { describe, expect, it } from "vitest";
import {
	githubQueryFilters,
	reduceGitHubWorkspaceFilters,
	setGitHubQueryFilter,
} from "./githubFilters";

describe("GitHub workspace filter transitions", () => {
	it.each(["issues", "pullRequests"] as const)(
		"lets an explicit %s actor replace Mine while retaining unrelated qualifiers",
		(view) => {
			const field = view === "issues" ? "assignee" : "author";
			const result = reduceGitHubWorkspaceFilters(
				{ view, preset: "mine", query: '-author:bot label:"needs review"' },
				{ type: "field", field, value: "dev" },
			);
			expect(result).toEqual({
				view,
				preset: "open",
				query: `-author:bot label:"needs review" ${field}:dev`,
			});
		},
	);
	it.each(["issues", "pullRequests"] as const)(
		"keeps %s preset and qualifier changes compatible",
		(view) => {
			const query =
				'retry "author:literal text" is:closed -assignee:bot -author:bot assignee:qa author:dev label:"needs review"';
			const closed = reduceGitHubWorkspaceFilters(
				{ view, preset: "open", query: "" },
				{ type: "query", value: query },
			);
			expect(closed).toEqual({ view, preset: "all", query });
			const mine = reduceGitHubWorkspaceFilters(closed, {
				type: "preset",
				value: "mine",
			});
			expect(githubQueryFilters(mine.query)).toEqual(
				view === "issues"
					? { author: "dev", label: "needs review" }
					: { assignee: "qa", label: "needs review" },
			);
			expect(mine.query).toContain('retry "author:literal text"');
			expect(mine.query).toContain("-assignee:bot -author:bot");
			expect(mine.preset).toBe("mine");
		},
	);
	it("keeps Projects text literal and resets view-specific filters on tab changes", () => {
		const projects = reduceGitHubWorkspaceFilters(
			{ view: "projects", preset: "open", query: "" },
			{ type: "query", value: "is:closed" },
		);
		expect(projects.preset).toBe("open");
		const all = reduceGitHubWorkspaceFilters(projects, {
			type: "preset",
			value: "all",
		});
		expect(all.query).toBe("is:closed");
		expect(
			reduceGitHubWorkspaceFilters(all, {
				type: "view",
				value: "pullRequests",
			}),
		).toEqual({ view: "pullRequests", preset: "open", query: "" });
	});
	it("admits merged work and preserves All when the search is cleared", () => {
		const merged = reduceGitHubWorkspaceFilters(
			{ view: "pullRequests", preset: "needsReview", query: "" },
			{ type: "query", value: "is:merged" },
		);
		expect(merged.preset).toBe("all");
		expect(
			reduceGitHubWorkspaceFilters(merged, { type: "query", value: "" }),
		).toEqual({ view: "pullRequests", preset: "all", query: "" });
	});
});

describe("GitHub filter query editing", () => {
	it("edits only positive target qualifiers while preserving text, quoted phrases and negative filters", () => {
		const query =
			'retry "author:literal text" is:issue is:open -label:bug label:"needs review" author:octo milestone:v2';
		const changed = setGitHubQueryFilter(query, "label", "help wanted");
		expect(changed).toBe(
			'retry "author:literal text" is:issue is:open -label:bug author:octo milestone:v2 label:"help wanted"',
		);
		expect(githubQueryFilters(changed)).toEqual({
			status: "open",
			author: "octo",
			label: "help wanted",
		});
	});
	it("replaces conflicting status forms without removing issue/pr or draft qualifiers", () => {
		expect(
			setGitHubQueryFilter(
				"is:pr is:draft state:open is:closed bug",
				"status",
				"merged",
			),
		).toBe("is:pr is:draft bug is:merged");
	});
	it("quotes whitespace and escapes in values instead of injecting extra qualifiers", () => {
		const value = 'needs "review" \\ label:other';
		expect(
			githubQueryFilters(setGitHubQueryFilter("hello", "label", value)).label,
		).toBe(value);
		expect(githubQueryFilters('"author:literal" -assignee:bob')).toEqual({});
	});
	it("clears every repeated positive field and keeps other conditions", () => {
		expect(
			setGitHubQueryFilter(
				'author:octo author:"other" assignee:@me',
				"author",
				"",
			),
		).toBe("assignee:@me");
	});
});
