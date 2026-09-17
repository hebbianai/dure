// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffBadges } from "@/lib/scm/status/diffBadgesStore";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent, Project } from "@/types";

const mocks = vi.hoisted(() => ({
	openAgentDiffWindow: vi.fn(),
	openSourceControlWindow: vi.fn(),
	gitAvailability: vi.fn(),
}));

vi.mock("@/lib/workspace/window/windows", () => mocks);
vi.mock("@/components/scm/useGitAvailability", () => ({
	useGitAvailability: mocks.gitAvailability,
}));

const project: Project = {
	id: "project-1",
	name: "Project",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

beforeEach(() => {
	useStore.setState({ gitStatuses: {}, gitStatusErrors: {} });
	mocks.gitAvailability.mockReturnValue({ state: { status: "available" } });
});

import { AgentPanelWindowActions } from "@/components/panels/AgentPanelWindowActions";

function agent(): Agent {
	return agentFixture({ displayName: "UI polish" });
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	useDiffBadges.setState({ badges: {} });
});

describe("AgentPanelWindowActions", () => {
	it("omits Git controls for an ordinary folder", () => {
		render(
			<AgentPanelWindowActions
				agent={agent()}
				project={{ ...project, isRepo: false }}
				showDiff
			/>,
		);
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(mocks.gitAvailability).toHaveBeenCalledWith(null, false);
	});

	it("restores Git controls when a registered ordinary folder becomes a repository", () => {
		render(
			<AgentPanelWindowActions
				agent={agent()}
				project={{ ...project, isRepo: false }}
				showDiff
			/>,
		);
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		act(() =>
			useStore.getState().setGitStatus("agent-1", {
				isRepo: true,
				branch: "main",
				ahead: 0,
				behind: 0,
				staged: 0,
				unstaged: 0,
				untracked: 0,
			}),
		);
		expect(screen.getAllByRole("button")).toHaveLength(2);
		fireEvent.click(screen.getAllByRole("button")[0]);
		expect(mocks.openAgentDiffWindow).toHaveBeenCalledWith("agent-1", "UI polish");
	});

	it.each(["missing", "unknown", "checking"])(
		"omits Git controls when Git is %s",
		(status) => {
			mocks.gitAvailability.mockReturnValue({ state: { status } });
			render(
				<AgentPanelWindowActions agent={agent()} project={project} showDiff />,
			);
			expect(screen.queryAllByRole("button")).toHaveLength(0);
		},
	);

	it("hides controls on a Git read failure and restores them after a successful observation", () => {
		render(
			<AgentPanelWindowActions agent={agent()} project={project} showDiff />,
		);
		act(() =>
			useStore
				.getState()
				.setGitStatusError("agent-1", "Git metadata unavailable"),
		);
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		act(() =>
			useStore.getState().setGitStatus("agent-1", {
				isRepo: true,
				branch: "main",
				ahead: 0,
				behind: 0,
				staged: 0,
				unstaged: 0,
				untracked: 0,
			}),
		);
		fireEvent.click(screen.getAllByRole("button")[1]);
		expect(mocks.openSourceControlWindow).toHaveBeenCalledOnce();
	});

	it("omits controls when a formerly registered repository is now an ordinary folder", () => {
		useStore.getState().setGitStatus("agent-1", {
			isRepo: false,
			branch: "",
			ahead: 0,
			behind: 0,
			staged: 0,
			unstaged: 0,
			untracked: 0,
		});
		render(
			<AgentPanelWindowActions agent={agent()} project={project} showDiff />,
		);
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});

	it("checks the selected SSH host independently from local Git", () => {
		render(
			<AgentPanelWindowActions
				agent={agent()}
				project={{ ...project, kind: "ssh", sshHostId: "remote-1" }}
				showDiff={false}
			/>,
		);
		expect(mocks.gitAvailability).toHaveBeenCalledWith("remote-1", true);
		fireEvent.click(screen.getByRole("button"));
		expect(mocks.openSourceControlWindow).toHaveBeenCalledOnce();
	});

	it("keeps diff and source-control launchers in the secondary toolbar", () => {
		const target = agent();
		render(
			<AgentPanelWindowActions agent={target} project={project} showDiff />,
		);

		const buttons = screen.getAllByRole("button");
		expect(buttons).toHaveLength(2);
		expect(buttons[0].getAttribute("aria-label")).toContain("diff");

		fireEvent.click(buttons[0]);
		expect(mocks.openAgentDiffWindow).toHaveBeenCalledWith(
			"agent-1",
			"UI polish",
		);
	});

	it("separates patch counts from branch divergence and keeps both numeric summaries visible", () => {
		useDiffBadges.setState({
			badges: {
				"agent-1": {
					added: 20,
					deleted: 4,
					binary: 0,
					files: 5,
					committed: { added: 12, deleted: 1, binary: 0, files: 2 },
					worktree: { added: 8, deleted: 3, binary: 0, files: 3 },
					ahead: 1,
					behind: 10,
				},
			},
		});

		render(
			<AgentPanelWindowActions agent={agent()} project={project} showDiff />,
		);

		const diff = screen.getByRole("button", { name: /C2 W3/ });
		const branch = screen.getByRole("button", { name: /↑1 ↓10/ });
		expect(diff.textContent).toBe("C2W3");
		expect(diff.textContent).not.toContain("↑");
		expect(branch.textContent).toBe("↑1↓10");
		expect(branch.textContent).not.toContain("C");

		fireEvent.click(branch);
		expect(mocks.openSourceControlWindow).toHaveBeenCalledOnce();
	});

	it("shows SSH worktree counters as an indicator when the diff window is unavailable", () => {
		useDiffBadges.setState({
			badges: {
				"agent-1": {
					added: 8,
					deleted: 3,
					binary: 0,
					files: 3,
					committed: { added: 0, deleted: 0, binary: 0, files: 0 },
					worktree: { added: 8, deleted: 3, binary: 0, files: 91 },
					ahead: 0,
					behind: 59,
				},
			},
		});

		render(
			<AgentPanelWindowActions
				agent={agent()}
				project={{ ...project, kind: "ssh", sshHostId: "remote-1" }}
				showDiff={false}
			/>,
		);

		const diff = screen.getByRole("button", { name: /W91/ });
		expect(diff.textContent).toBe("W91");
		expect(diff.getAttribute("aria-label")).not.toContain("window");
		// Not `disabled`: the hover bubble is the only place the counters are
		// explained, and a disabled control cannot open it.
		expect(diff.hasAttribute("disabled")).toBe(false);
		fireEvent.click(diff);
		expect(mocks.openAgentDiffWindow).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: /↓59/ }).textContent).toBe("↓59");
	});

	it("hides the diff launcher on SSH panes that carry no badge", () => {
		render(
			<AgentPanelWindowActions
				agent={agent()}
				project={{ ...project, kind: "ssh", sshHostId: "remote-1" }}
				showDiff={false}
			/>,
		);
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});
