// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitPanel } from "./GitPanel";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	gitInfo: vi.fn(),
	gitExec: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/components/workspace/usePaneFirstReveal", () => ({
	usePaneFirstReveal: () => true,
}));
vi.mock("@/lib/scm/history/git", () => ({
	gitInfo: mocks.gitInfo,
	gitExec: mocks.gitExec,
	gitRemoteUrl: vi.fn(),
}));

const props = {
	params: { projectId: "repo" },
	api: {},
} as IDockviewPanelProps<{ projectId: string }>;

beforeEach(() => {
	vi.resetAllMocks();
	useStore.setState({
		projects: [
			{
				id: "repo",
				name: "repo",
				path: "/work/repo",
				kind: "local",
				isRepo: true,
			},
		],
	});
	mocks.gitInfo.mockResolvedValue({
		branch: "main",
		ahead: 0,
		behind: 0,
		files: [],
	});
	mocks.gitExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
});
afterEach(cleanup);

describe("Git availability in source control", () => {
	it("shows installation guidance instead of a clean working tree or mutation buttons when Git is missing", async () => {
		mocks.invoke.mockResolvedValue({ status: "missing" });
		render(<GitPanel {...props} />);
		await screen.findByText(t("panels.git.availability.missing"));
		expect(screen.queryByText(t("panels.git.cleanWorkingTree"))).toBeNull();
		expect(screen.queryByRole("button", { name: "Pull" })).toBeNull();
		expect(mocks.gitInfo).not.toHaveBeenCalled();
		expect(mocks.gitExec).not.toHaveBeenCalled();
	});

	it("rechecks after installation and restores Git actions", async () => {
		mocks.invoke
			.mockResolvedValueOnce({ status: "missing" })
			.mockResolvedValue({ status: "available" });
		render(<GitPanel {...props} />);
		fireEvent.click(
			await screen.findByRole("button", {
				name: t("panels.git.availability.recheck"),
			}),
		);
		await screen.findByText(t("panels.git.cleanWorkingTree"));
		fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
		await waitFor(() =>
			expect(mocks.gitExec).toHaveBeenCalledWith(
				expect.objectContaining({ id: "repo" }),
				["fetch", "--all", "--prune"],
			),
		);
	});
});
