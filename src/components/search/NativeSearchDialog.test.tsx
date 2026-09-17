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

const mocks = vi.hoisted(() => ({
	navigateToPanel: vi.fn(),
	writeText: vi.fn(),
	runShell: vi.fn(),
	requestFeedback: vi.fn(),
	panels: [] as Array<{
		id: string;
		params: Record<string, unknown>;
		api: { component: string; getParameters(): unknown };
	}>,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: mocks.writeText,
}));
vi.mock("@/lib/workspace/dock/openScmPanel", () => ({
	openGitPanel: vi.fn(),
}));
vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanelOnDesktop: vi.fn(),
	openInheritedTerminalPanel: vi.fn(),
	openSshTerminalPanelOnDesktop: vi.fn(),
	openTerminalPanelOnDesktop: vi.fn(),
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock/dockRegistry")>()),
	mountedDockviewEntries: () => [["desk-1", { panels: mocks.panels }]],
}));
vi.mock("@/lib/workspace/dock/panelFocusHandoff", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock/panelFocusHandoff")>()),
	navigateToPanel: mocks.navigateToPanel,
}));
vi.mock("@/lib/files/fileViewerPane", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/files/fileViewerPane")>()),
	openFileViewer: vi.fn(),
}));
vi.mock("@/lib/ipc/process", () => ({
	runShell: mocks.runShell,
}));
vi.mock("@/lib/ipc", () => ({
	hostToOpts: vi.fn(),
	sshExecOnce: vi.fn(),
}));
vi.mock("@/lib/feedback/feedbackActivation", () => ({
	requestFeedback: mocks.requestFeedback,
}));

import { NativeSearchDialog } from "@/components/search/NativeSearchDialog";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { useStore } from "@/store";

describe("NativeSearchDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.panels = [
			{
				id: "agent:alpha",
				params: { agentRef: { agentId: "alpha" } },
				api: { component: "agent", getParameters: () => ({}) },
			},
			{
				id: "pane-beta",
				params: { agentRef: { agentId: "beta" } },
				api: { component: "agent", getParameters: () => ({}) },
			},
		];
		mocks.runShell.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
		mocks.writeText.mockResolvedValue(undefined);
		useAgentAttention.setState({ displayStates: {} });
		useStore.setState({
			activeSpaceId: "desk-1",
			spaces: [{ id: "desk-1", name: "Main" }],
			layouts: {},
			projects: [
				{
					id: "project-1",
					name: "Dure",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [
				{
					id: "alpha",
					name: "Alpha",
					provider: "codex",
					projectId: "project-1",
					worktreePath: "/repo/.worktrees/alpha",
					branch: "alpha",
					sessionId: "alpha-session",
					sessionKind: "pty",
				},
				{
					id: "beta",
					name: "Beta",
					provider: "claude",
					projectId: "project-1",
					worktreePath: "/repo/.worktrees/beta",
					branch: "beta",
					sessionId: "beta-session",
					sessionKind: "pty",
				},
			],
			detected: {},
			sshHosts: [],
			agentActivity: { alpha: "working", beta: "waiting" },
			sessionAgentRuntimeState: {},
			sessionCwd: {},
			sessionAgent: {},
			sessionAgentPin: {},
			sessionTitle: {},
			sessionActivity: {},
			sshStates: {},
			gitStatuses: {},
		});
	});

	afterEach(() => cleanup());

	it("opens from a preserved request, scopes agents, and focuses the selected pane", async () => {
		render(
			<NativeSearchDialog request={{ revision: 1, initialQuery: "" }} />,
		);

		const input = await screen.findByRole("combobox");
		fireEvent.change(input, { target: { value: "@ beta" } });
		expect(await screen.findByText("Beta")).toBeTruthy();
		fireEvent.keyDown(input, { key: "Enter" });

		expect(mocks.navigateToPanel).toHaveBeenCalledWith("desk-1", "pane-beta");
	});

	it("searches shell history and copies a command instead of executing it", async () => {
		mocks.runShell.mockResolvedValue({
			stdout: ": 1720000000:0;git status\n",
			stderr: "",
			code: 0,
		});
		render(
			<NativeSearchDialog request={{ revision: 1, initialQuery: "" }} />,
		);

		const input = await screen.findByRole("combobox");
		fireEvent.change(input, { target: { value: "> git status" } });
		await waitFor(() => expect(screen.getByText("git status")).toBeTruthy());
		expect(screen.getByText("Enter 복사")).toBeTruthy();
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() =>
			expect(mocks.writeText).toHaveBeenCalledWith("git status"),
		);
		expect(mocks.navigateToPanel).not.toHaveBeenCalled();
	});

	it("only activates feedback once this palette is actually gone, not after a fixed delay", async () => {
		render(<NativeSearchDialog request={{ revision: 1, initialQuery: "" }} />);

		// requestFeedback() itself reports whether the palette was still in the
		// DOM at the moment it fired — pinning the ordering to that fact, not
		// to any particular number of frames or a timer.
		const paletteStillPresentWhenCalled: boolean[] = [];
		mocks.requestFeedback.mockImplementation(() => {
			paletteStillPresentWhenCalled.push(screen.queryByRole("dialog") !== null);
		});

		const input = await screen.findByRole("combobox");
		expect(screen.getByRole("dialog")).toBeTruthy();
		fireEvent.change(input, { target: { value: "> feedback" } });
		await waitFor(() => expect(mocks.requestFeedback).not.toHaveBeenCalled());
		fireEvent.keyDown(input, { key: "Enter" });

		// The dialog starts closing synchronously (setOpen(false) inside
		// execute()), but requestFeedback() must not fire until Radix's own
		// onCloseAutoFocus says the close finished — not merely after this
		// dialog's onOpenChange or a microtask.
		await waitFor(() => expect(mocks.requestFeedback).toHaveBeenCalledTimes(1));
		expect(paletteStillPresentWhenCalled).toEqual([false]);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// The pending flag is only ever consumed by onCloseAutoFocus, which
	// Radix skips entirely when a reopen cancels the unmount. The flag then
	// outlives the request that set it and fires a capture on some later,
	// unrelated close — for a feature whose whole premise is "only on an
	// explicit user action", the wrong failure. Reopening the palette in the
	// same commit as the close is exactly that cancellation.
	it("does not carry a pending feedback request into a palette that reopened", async () => {
		const { rerender } = render(
			<NativeSearchDialog request={{ revision: 1, initialQuery: "" }} />,
		);
		const input = await screen.findByRole("combobox");
		fireEvent.change(input, { target: { value: "> feedback" } });
		await waitFor(() => expect(mocks.requestFeedback).not.toHaveBeenCalled());

		act(() => {
			fireEvent.keyDown(input, { key: "Enter" });
			rerender(<NativeSearchDialog request={{ revision: 2, initialQuery: "" }} />);
		});
		expect(screen.getByRole("dialog")).toBeTruthy();

		// This second close is an ordinary dismissal: the user never asked
		// for feedback in this session of the palette.
		const reopened = await screen.findByRole("combobox");
		fireEvent.keyDown(reopened, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(mocks.requestFeedback).not.toHaveBeenCalled();
	});
});
