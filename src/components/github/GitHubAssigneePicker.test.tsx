// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "@/lib/i18n";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc/github", () => ({ ghAssignableUsers: read }));

import { GitHubAssigneePicker } from "./GitHubAssigneePicker";

const repository = {
	projectId: "p",
	projectName: "Repo",
	path: "/repo",
	nameWithOwner: "team/repo",
	owner: "team",
	url: "https://github.example/team/repo",
	isInOrganization: true,
};
const save = vi.fn();
function mount() {
	return render(
		<GitHubAssigneePicker
			repository={repository}
			values={["dev"]}
			disabled={false}
			error={null}
			onSave={save}
		/>,
	);
}
function open() {
	fireEvent.keyDown(screen.getByRole("button", { name: "Edit assignees" }), {
		key: "ArrowDown",
	});
}
beforeEach(() => {
	setLang("en");
	read.mockReset().mockResolvedValue({ ok: true, value: ["dev", "qa"] });
	save.mockReset().mockResolvedValue(false);
});
afterEach(() => {
	cleanup();
	setLang("ko");
});

describe("GitHubAssigneePicker", () => {
	it("loads only on opening, filters candidates, and permits keyboard selection without changing confirmed values", async () => {
		mount();
		expect(read).not.toHaveBeenCalled();
		open();
		await screen.findByRole("menuitemcheckbox", { name: "qa" });
		const search = screen.getByRole("textbox", { name: "Filter assignees…" });
		fireEvent.change(search, { target: { value: "@QA" } });
		expect(screen.queryByRole("menuitemcheckbox", { name: "dev" })).toBeNull();
		fireEvent.keyDown(search, { key: "ArrowDown" });
		const qa = screen.getByRole("menuitemcheckbox", { name: "qa" });
		expect(document.activeElement).toBe(qa);
		fireEvent.keyDown(qa, { key: "Enter" });
		await waitFor(() =>
			expect(save).toHaveBeenCalledWith({
				kind: "assignees",
				before: [],
				after: ["qa"],
			}),
		);
		expect(qa.getAttribute("aria-checked")).toBe("false");
		fireEvent.keyDown(search, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Edit assignees" }),
		);
		open();
		expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
	});
	it("removes only the selected login, keeping it checked until a confirmed refresh", async () => {
		mount();
		open();
		const dev = await screen.findByRole("menuitemcheckbox", { name: "dev" });
		fireEvent.click(dev);
		await waitFor(() =>
			expect(save).toHaveBeenCalledWith({
				kind: "assignees",
				before: ["dev"],
				after: [],
			}),
		);
		expect(dev.getAttribute("aria-checked")).toBe("true");
	});
	it("shows a failed lookup and retries without losing the current assignee", async () => {
		read.mockResolvedValueOnce({
			ok: false,
			error: { kind: "command-failed", detail: "Permission denied" },
		});
		mount();
		open();
		expect(await screen.findByText("Permission denied")).toBeTruthy();
		expect(
			screen
				.getByRole("menuitemcheckbox", { name: "dev" })
				.getAttribute("aria-checked"),
		).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(
			await screen.findByRole("menuitemcheckbox", { name: "qa" }),
		).toBeTruthy();
		expect(screen.queryByText("Permission denied")).toBeNull();
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "absent" },
		});
		expect(screen.getByText("No matching assignees.")).toBeTruthy();
	});
	it("ignores a stale lookup after closing and reopening the menu", async () => {
		let finish: (value: unknown) => void = () => {};
		read.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		mount();
		open();
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		open();
		await screen.findByRole("menuitemcheckbox", { name: "qa" });
		await act(async () => finish({ ok: true, value: ["stale-user"] }));
		expect(
			screen.queryByRole("menuitemcheckbox", { name: "stale-user" }),
		).toBeNull();
	});
});
