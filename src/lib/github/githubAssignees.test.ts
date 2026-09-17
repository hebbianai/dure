import { describe, expect, it } from "vitest";
import {
	githubAssigneeChoices,
	parseGitHubAssignableUsers,
} from "./githubAssignees";

describe("GitHub assignees", () => {
	it("parses all CLI pages without masking malformed users as an empty list", () => {
		expect(
			parseGitHubAssignableUsers(
				'[[{"login":"dev"}],[{"login":"qa"},{"login":"dev"}]]',
			),
		).toEqual(["dev", "qa"]);
		expect(parseGitHubAssignableUsers("[[]]")).toEqual([]);
		for (const json of [
			'[[{"login":"dev"},null]]',
			'[[{"login":""}]]',
			'[{"login":"dev"}]',
			"{}",
			"not json",
		])
			expect(parseGitHubAssignableUsers(json)).toBeNull();
	});
	it("searches case-insensitively and retains assigned users absent from candidates", () => {
		expect(
			githubAssigneeChoices(["qa", "DEV"], ["dev", "former-member"], ""),
		).toEqual([
			{ login: "dev", selected: true },
			{ login: "former-member", selected: true },
			{ login: "qa", selected: false },
		]);
		expect(githubAssigneeChoices(["qa", "dev"], [], " @QA ")).toEqual([
			{ login: "qa", selected: false },
		]);
		expect(githubAssigneeChoices(["qa"], [], "missing")).toEqual([]);
	});
});
