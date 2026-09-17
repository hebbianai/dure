// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorktreeTabs } from "./WorktreeTabs";

afterEach(cleanup);

describe("WorktreeTabs branch input", () => {
	it("disables native text completion when entering a branch name", () => {
		// Given: the branch-name input is visible.
		render(
			<WorktreeTabs
				tab="smart"
				onTabChange={() => {}}
				query="fix"
				onQueryChange={() => {}}
				suggestions={[]}
				onPickSuggestion={() => {}}
			/>,
		);

		// When: the browser reads the input's native text-service policy.
		const input = screen.getByRole("textbox");

		// Then: it must not offer saved, capitalized, corrected, or spellchecked text.
		expect(input.getAttribute("autocomplete")).toBe("off");
		expect(input.getAttribute("autocapitalize")).toBe("none");
		expect(input.getAttribute("autocorrect")).toBe("off");
		expect(input.getAttribute("spellcheck")).toBe("false");
	});
});
