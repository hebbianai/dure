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
import type { GitHubIssueDetails } from "@/lib/github/githubIssueDetails";
import { setLang } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	mutate: vi.fn(),
	assignees: vi.fn(),
	external: vi.fn(),
	start: vi.fn(),
}));
vi.mock("@/lib/ipc/github", () => ({
	ghIssueDetails: mocks.read,
	ghMutateIssue: mocks.mutate,
	ghAssignableUsers: mocks.assignees,
}));
vi.mock("@/lib/platform/externalOpen", () => ({
	openExternalUrl: mocks.external,
}));
vi.mock("@/lib/agents/quickDispatch/quickDispatchActivation", () => ({
	requestQuickDispatch: mocks.start,
}));
vi.mock("@/lib/workspace/dock", () => ({ openAgentPanelOnDesktop: vi.fn() }));

import { GitHubIssueDetail } from "./GitHubIssueDetail";

const detail: GitHubIssueDetails = {
	id: "I_issue42",
	kind: "issue",
	number: 42,
	title: "Fix refresh",
	url: "https://github.com/team/repo/issues/42",
	state: "OPEN",
	isDraft: false,
	author: "dev",
	body: "The **refresh lifecycle** needs a fix.",
	assignees: ["dev"],
	labels: ["bug"],
	reviewRequests: [],
	createdAt: "2026-09-07T00:00:00Z",
	updatedAt: "2026-09-07T01:00:00Z",
	checks: { total: 0, passed: 0, pending: 0, failed: 0 },
	comments: [
		{
			id: "comment-1",
			body: "I can reproduce it.",
			author: "qa",
			createdAt: "2026-09-07T01:00:00Z",
			url: "https://github.com/team/repo/issues/42#issuecomment-1",
		},
	],
	repository: {
		projectId: "project-1",
		projectName: "Repo",
		path: "/repo",
		nameWithOwner: "team/repo",
		owner: "team",
		url: "https://github.com/team/repo",
		isInOrganization: true,
	},
};
const onUpdated = vi.fn();
function mount() {
	return render(
		<GitHubIssueDetail
			row={detail}
			agents={[]}
			activeSpaceId="space-1"
			onBack={vi.fn()}
			onUpdated={onUpdated}
		/>,
	);
}
beforeEach(() => {
	setLang("en");
	onUpdated.mockReset();
	mocks.read.mockReset().mockResolvedValue({ ok: true, value: detail });
	mocks.mutate.mockReset().mockResolvedValue({ ok: true, value: null });
	mocks.assignees
		.mockReset()
		.mockResolvedValue({ ok: true, value: ["dev", "qa"] });
	mocks.external.mockReset();
	mocks.start.mockReset();
});
afterEach(() => {
	cleanup();
	setLang("ko");
});

describe("GitHubIssueDetail", () => {
	it("selects actual repository assignees from a checked menu and waits for the confirmed snapshot", async () => {
		mount();
		const edit = await screen.findByRole("button", { name: "Edit assignees" });
		fireEvent.keyDown(edit, { key: "ArrowDown" });
		const existing = await screen.findByRole("menuitemcheckbox", {
			name: "dev",
		});
		expect(existing.getAttribute("aria-checked")).toBe("true");
		const candidate = screen.getByRole("menuitemcheckbox", { name: "qa" });
		let confirm: (value: unknown) => void = () => {};
		mocks.mutate.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					confirm = resolve;
				}),
		);
		mocks.read.mockResolvedValueOnce({
			ok: true,
			value: { ...detail, assignees: ["dev", "qa"] },
		});
		fireEvent.click(candidate);
		expect(candidate.getAttribute("aria-checked")).toBe("false");
		expect(mocks.mutate).toHaveBeenLastCalledWith(detail, {
			kind: "assignees",
			before: [],
			after: ["qa"],
		});
		await act(async () => confirm({ ok: true, value: null }));
		await waitFor(() =>
			expect(candidate.getAttribute("aria-checked")).toBe("true"),
		);
		expect(mocks.assignees).toHaveBeenCalledWith(detail.repository);
	});
	it("loads body and comments, offers explicit browser navigation and the shared Start action", async () => {
		mount();
		expect(await screen.findByText("refresh lifecycle")).toBeTruthy();
		expect(screen.getByText("I can reproduce it.")).toBeTruthy();
		expect(mocks.external).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));
		expect(mocks.external).toHaveBeenCalledWith(detail.url);
		fireEvent.click(screen.getByRole("button", { name: /Start/ }));
		expect(mocks.start).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project-1" }),
		);
	});
	it("keeps an assignee write failure visible in the open menu without flipping the check", async () => {
		mount();
		fireEvent.keyDown(
			await screen.findByRole("button", { name: "Edit assignees" }),
			{ key: "ArrowDown" },
		);
		const qa = await screen.findByRole("menuitemcheckbox", { name: "qa" });
		mocks.mutate.mockResolvedValueOnce({
			ok: false,
			error: { kind: "command-failed", detail: "Assignment denied" },
		});
		fireEvent.click(qa);
		await waitFor(() =>
			expect(screen.getByRole("menu").textContent).toContain(
				"Assignment denied",
			),
		);
		expect(qa.getAttribute("aria-checked")).toBe("false");
		expect(mocks.read).toHaveBeenCalledTimes(1);
	});
	it("keeps a failed comment draft and clears a confirmed post even if the subsequent refresh fails", async () => {
		mount();
		const input = await screen.findByRole("textbox", { name: "Add a comment" });
		fireEvent.change(input, { target: { value: "Evidence with `Markdown`." } });
		mocks.mutate.mockResolvedValueOnce({
			ok: false,
			error: { kind: "command-failed", detail: "Permission denied" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
		expect(await screen.findByText("Permission denied")).toBeTruthy();
		expect((input as HTMLTextAreaElement).value).toBe(
			"Evidence with `Markdown`.",
		);
		mocks.read.mockResolvedValueOnce({
			ok: false,
			error: { kind: "command-failed", detail: "Read unavailable" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
		expect(await screen.findByText("Read unavailable")).toBeTruthy();
		expect((input as HTMLTextAreaElement).value).toBe("");
		expect(mocks.mutate).toHaveBeenLastCalledWith(detail, {
			kind: "comment",
			body: "Evidence with `Markdown`.",
		});
	});
	it("changes status only after GitHub confirms it and publishes the new list projection", async () => {
		mount();
		const status = await screen.findByRole("button", { name: "Status" });
		let confirm: (value: unknown) => void = () => {};
		mocks.mutate.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					confirm = resolve;
				}),
		);
		fireEvent.keyDown(status, { key: "ArrowDown" });
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "Close as completed" }),
		);
		expect(status.textContent).toBe("Open");
		mocks.read.mockResolvedValueOnce({
			ok: true,
			value: { ...detail, state: "CLOSED" },
		});
		await act(async () => confirm({ ok: true, value: null }));
		await waitFor(() => expect(status.textContent).toBe("Closed"));
		expect(onUpdated).toHaveBeenLastCalledWith(
			expect.objectContaining({ state: "CLOSED" }),
		);
	});
	it("saves body and metadata through explicit edits without dropping a rejected draft", async () => {
		mount();
		await screen.findByText("refresh lifecycle");
		fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
			target: { value: "Updated body" },
		});
		mocks.mutate.mockResolvedValueOnce({
			ok: false,
			error: { kind: "command-failed", detail: "Edit denied" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText("Edit denied")).toBeTruthy();
		expect(
			(
				screen.getByRole("textbox", {
					name: "Description",
				}) as HTMLTextAreaElement
			).value,
		).toBe("Updated body");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Labels" }), {
			target: { value: "bug, ready" },
		});
		mocks.read.mockResolvedValueOnce({
			ok: true,
			value: { ...detail, labels: ["bug", "ready"] },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText("ready")).toBeTruthy();
		expect(mocks.mutate).toHaveBeenLastCalledWith(detail, {
			kind: "labels",
			before: ["bug"],
			after: ["bug", "ready"],
		});
	});
	it("recovers a failed initial read without navigating away", async () => {
		mocks.read.mockResolvedValueOnce({
			ok: false,
			error: { kind: "command-failed", detail: "Offline" },
		});
		mount();
		expect(await screen.findByText("Offline")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("refresh lifecycle")).toBeTruthy();
		expect(mocks.external).not.toHaveBeenCalled();
	});
	it("preserves an active draft across refreshed snapshots and applies metadata edits against their original baseline", async () => {
		mount();
		await screen.findByText("refresh lifecycle");
		fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
			target: { value: "My unsaved draft" },
		});
		const latest = {
			...detail,
			body: "Another author's update",
			labels: ["bug", "reviewed"],
		};
		mocks.read.mockResolvedValueOnce({ ok: true, value: latest });
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(onUpdated).toHaveBeenLastCalledWith(latest));
		expect(
			(
				screen.getByRole("textbox", {
					name: "Description",
				}) as HTMLTextAreaElement
			).value,
		).toBe("My unsaved draft");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByText("Another author's update")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Labels" }), {
			target: { value: "bug, reviewed, ready" },
		});
		const updatedLabels = {
			...latest,
			labels: ["bug", "reviewed", "priority:p1"],
		};
		mocks.read.mockResolvedValueOnce({ ok: true, value: updatedLabels });
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(onUpdated).toHaveBeenLastCalledWith(updatedLabels),
		);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(mocks.mutate).toHaveBeenLastCalledWith(updatedLabels, {
				kind: "labels",
				before: ["bug", "reviewed"],
				after: ["bug", "reviewed", "ready"],
			}),
		);
	});
	it("ignores a detail response after the selected surface unmounts", async () => {
		let finish: (value: unknown) => void = () => {};
		mocks.read.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const view = mount();
		view.unmount();
		await act(async () => finish({ ok: true, value: detail }));
		expect(onUpdated).not.toHaveBeenCalled();
	});
});
