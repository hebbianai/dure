// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	GitHubIssueDetails,
	GitHubIssueMutation,
} from "@/lib/github/githubIssueDetails";
import { setLang } from "@/lib/i18n";
import { GitHubIssueStatusControl } from "./GitHubIssueStatusControl";

const detail = {
	kind: "issue",
	number: 42,
	state: "OPEN",
} as GitHubIssueDetails;
beforeEach(() => setLang("en"));
afterEach(() => {
	cleanup();
	setLang("ko");
});
async function openMenu() {
	fireEvent.keyDown(screen.getByRole("button", { name: "Status" }), {
		key: "ArrowDown",
	});
	await screen.findByRole("menu");
}
describe("GitHubIssueStatusControl", () => {
	it.each([
		["Close as completed", "completed"],
		["Close as not planned", "not planned"],
	])(
		"sends the explicit %s intent without optimistically changing state",
		async (label, reason) => {
			const onSave = vi.fn().mockResolvedValue(false);
			render(
				<GitHubIssueStatusControl
					detail={detail}
					disabled={false}
					onSave={onSave}
				/>,
			);
			await openMenu();
			fireEvent.click(screen.getByRole("menuitem", { name: label }));
			expect(onSave).toHaveBeenCalledWith({
				kind: "state",
				state: "CLOSED",
				reason,
			});
			expect(screen.getByRole("button", { name: "Status" }).textContent).toBe(
				"Open",
			);
		},
	);
	it("reopens a closed not-planned issue", async () => {
		const onSave = vi.fn().mockResolvedValue(true);
		render(
			<GitHubIssueStatusControl
				detail={{ ...detail, state: "CLOSED", stateReason: "NOT_PLANNED" }}
				disabled={false}
				onSave={onSave}
			/>,
		);
		expect(screen.getByRole("button", { name: "Status" }).textContent).toBe(
			"Not planned",
		);
		await openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
		expect(onSave).toHaveBeenCalledWith({ kind: "state", state: "OPEN" });
	});
	it("requires a different issue number, preserves a rejected draft and clears only after confirmation", async () => {
		const onSave = vi.fn().mockResolvedValue(false);
		render(
			<GitHubIssueStatusControl
				detail={detail}
				disabled={false}
				onSave={onSave}
			/>,
		);
		await openMenu();
		fireEvent.click(
			screen.getByRole("menuitem", { name: "Close as duplicate" }),
		);
		const input = screen.getByRole("textbox", {
			name: "Original issue number",
		});
		fireEvent.change(input, { target: { value: "#42" } });
		const close = screen.getByRole("button", { name: "Close" });
		expect((close as HTMLButtonElement).disabled).toBe(true);
		expect(onSave).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: "#77" } });
		fireEvent.click(close);
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				{ kind: "duplicate", number: 77 },
				expect.any(Function),
			),
		);
		expect((input as HTMLInputElement).value).toBe("#77");
		onSave.mockImplementationOnce(
			async (_mutation: GitHubIssueMutation, confirmed?: () => void) => {
				confirmed?.();
				return true;
			},
		);
		fireEvent.click(close);
		await waitFor(() =>
			expect(
				screen.queryByRole("textbox", { name: "Original issue number" }),
			).toBeNull(),
		);
	});
});
