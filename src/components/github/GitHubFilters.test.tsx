// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reduceGitHubWorkspaceFilters } from "@/lib/github/githubFilters";
import { setLang } from "@/lib/i18n";
import { GitHubFilters } from "./GitHubFilters";

beforeEach(() => setLang("en"));
afterEach(() => {
	cleanup();
	setLang("ko");
});
async function openFilters() {
	fireEvent.keyDown(screen.getByRole("button", { name: "Filters" }), {
		key: "ArrowDown",
	});
	await screen.findByRole("menu");
}
function Fixture({
	initial,
}: {
	initial: Parameters<typeof reduceGitHubWorkspaceFilters>[0];
}) {
	const [filters, change] = useReducer(reduceGitHubWorkspaceFilters, initial);
	return (
		<>
			<GitHubFilters
				{...filters}
				rows={[]}
				onFilterChange={(field, value) =>
					change({ type: "field", field, value })
				}
				onPresetChange={(value) => change({ type: "preset", value })}
			/>
			<output aria-label="Query">{filters.query}</output>
			<output aria-label="Preset">{filters.preset}</output>
		</>
	);
}
const query = () => screen.getByRole("status", { name: "Query" }).textContent;
const preset = () => screen.getByRole("status", { name: "Preset" }).textContent;

describe("GitHub filters", () => {
	it("applies an authored query only on explicit submit, then reopens the root menu", async () => {
		render(
			<Fixture
				initial={{ query: "retry label:bug", preset: "open", view: "issues" }}
			/>,
		);
		await openFilters();
		fireEvent.click(screen.getByRole("menuitem", { name: "Author" }));
		const input = screen.getByRole("textbox", { name: "Author" });
		expect(document.activeElement).toBe(input);
		fireEvent.change(input, { target: { value: "octo" } });
		expect(query()).toBe("retry label:bug");
		expect(
			fireEvent.keyDown(screen.getByRole("button", { name: "Clear" }), {
				key: "Tab",
			}),
		).toBe(true);
		fireEvent.submit(input.closest("form") as HTMLFormElement);
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		expect(query()).toBe("retry label:bug author:octo");
		await openFilters();
		expect(
			await screen.findByRole("menuitem", { name: /^Author/ }),
		).toBeTruthy();
		expect(screen.queryByRole("textbox")).toBeNull();
	});
	it("makes closed status compatible with the native preset without losing other filters", async () => {
		render(
			<Fixture
				initial={{ query: "label:bug is:open", preset: "open", view: "issues" }}
			/>,
		);
		await openFilters();
		fireEvent.click(screen.getByRole("menuitem", { name: /^Status/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: "Closed" }));
		expect(preset()).toBe("all");
		expect(query()).toBe("label:bug is:closed");
	});
	it("clears an assignee without removing a negative qualifier or free text", async () => {
		render(
			<Fixture
				initial={{
					query: "retry assignee:octo -label:bug",
					preset: "open",
					view: "issues",
				}}
			/>,
		);
		await openFilters();
		fireEvent.click(screen.getByRole("menuitem", { name: /^Assignee/ }));
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		expect(query()).toBe("retry -label:bug");
	});
	it("keeps Projects status in its native preset, not its title search", async () => {
		render(
			<Fixture
				initial={{ query: "launch", preset: "open", view: "projects" }}
			/>,
		);
		await openFilters();
		expect(screen.queryByRole("menuitem", { name: "Author" })).toBeNull();
		fireEvent.click(screen.getByRole("menuitem", { name: /^Status/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: "All" }));
		expect(preset()).toBe("all");
		expect(query()).toBe("launch");
	});
});
