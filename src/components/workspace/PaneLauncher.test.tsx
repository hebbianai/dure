// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { type DockviewApi, DockviewReact } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import type { PaneSplitPaneParams } from "@/lib/workspace/pane/paneSplitTarget";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";

const mocks = vi.hoisted(() => ({
	terminal: vi.fn(),
	agent: vi.fn(),
	quickAgent: vi.fn(),
	quickAdd: vi.fn(),
	pickFolder: vi.fn(),
	commitLayout: vi.fn(),
	error: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.pickFolder }));
vi.mock("@/lib/toast", () => ({ showErrorToast: mocks.error }));
vi.mock("@/components/workspace/WorkspaceRuntimeContext", () => ({
	useWorkspaceRuntimeDesktopId: () => "desk-1",
	useWorkspaceDurableLayoutCommit: () => mocks.commitLayout,
}));
vi.mock("@/lib/workspace/dock", () => ({ openAgentPanel: mocks.agent }));
vi.mock("@/lib/workspace/pane/paneSplit", async (original) => ({
	...(await original<typeof import("@/lib/workspace/pane/paneSplit")>()),
	openSplitTerminalPanel: mocks.terminal,
}));
vi.mock("@/components/spaces/useRepositoryQuickAdd", () => ({
	useRepositoryQuickAdd: (...args: unknown[]) => {
		mocks.quickAdd(...args);
		return { onAddRepositoryAgent: mocks.quickAgent };
	},
}));
vi.mock("@/components/agents/WorktreeAgentDialog", () => ({
	WorktreeAgentDialog: (props: {
		initialProvider?: string;
		initialPath?: string;
		onClose: () => void;
		onCreated: (agent: unknown) => void;
	}) => (
		<div
			role="dialog"
			data-provider={props.initialProvider}
			data-path={props.initialPath}
		>
			<button type="button" onClick={props.onClose}>
				Cancel creation
			</button>
			<button
				type="button"
				onClick={() => props.onCreated({ id: "new-agent" })}
			>
				Finish creation
			</button>
		</div>
	),
}));

import { PaneLauncher } from "./PaneLauncher";

const previous = useStore.getState();
const components = { launcher: PaneLauncher };
function mount(
	params: PaneSplitPaneParams = { cwd: "/repo" },
	panelId = "launcher:pick",
) {
	let api!: DockviewApi;
	const view = render(
		<DockviewReact
			components={components}
			onReady={(event) => {
				api = event.api;
				api.addPanel({ id: panelId, component: "launcher", params });
			}}
		/>,
	);
	return { ...view, api };
}
beforeEach(() => {
	vi.clearAllMocks();
	useStore.setState({
		installedAgents: ["claude", "codex"],
		skipPermissions: {},
		sshHosts: [],
		agents: [],
		focusCtx: { source: "local", cwd: "/unrelated", label: "Other pane" },
	});
});
afterEach(() => {
	cleanup();
	useStore.setState(previous);
});

describe("split pane launcher", () => {
	it.each(["slot", "agent:old", "term:old"])(
		"launches from the current selector location in %s, not its former Agent",
		async (panelId) => {
			useStore.setState({
				agents: [agentFixture({ id: "old", worktreePath: "/former-agent" })],
			});
			const { api } = mount({ cwd: "/current-selector" }, panelId);
			expect(
				screen.getByRole("button", { name: t("common.location") }).textContent,
			).toContain("/current-selector");
			await act(async () =>
				fireEvent.click(screen.getByRole("button", { name: "터미널" })),
			);
			expect(mocks.terminal).toHaveBeenCalledWith(
				"desk-1",
				{ kind: "local", cwd: "/current-selector" },
				{ replacement: api.getPanel(panelId)!.api },
			);
		},
	);
	it.each(["terminal", "agent"])(
		"shows pending %s creation immediately and prevents competing launches until it settles",
		async (kind) => {
			mount();
			let finish!: () => void;
			const create = kind === "terminal" ? mocks.terminal : mocks.quickAgent;
			create.mockReturnValueOnce(
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
			);
			const terminal = screen.getByRole<HTMLButtonElement>("button", {
				name: "터미널",
			});
			const agent = screen.getByRole<HTMLButtonElement>("button", {
				name: /^codex/,
			});
			const selected = kind === "terminal" ? terminal : agent;
			fireEvent.click(selected);
			expect(terminal.disabled).toBe(true);
			expect(agent.disabled).toBe(true);
			expect(
				within(screen.getByRole("tabpanel")).getByRole("status").textContent,
			).toBe(t("common.opening"));
			expect(
				screen.getByRole<HTMLButtonElement>("button", {
					name: t("common.location"),
				}).disabled,
			).toBe(true);
			expect(
				screen.getByRole<HTMLButtonElement>("button", {
					name: t("spaces.repository.addWithOptions"),
				}).disabled,
			).toBe(true);
			fireEvent.click(terminal);
			fireEvent.click(agent);
			expect(create).toHaveBeenCalledTimes(1);
			expect(
				kind === "terminal" ? mocks.quickAgent : mocks.terminal,
			).not.toHaveBeenCalled();
			await act(async () => finish());
			// Creation owners report errors themselves. A settled failed attempt
			// leaves the selector mounted and must allow an explicit retry.
			expect(terminal.disabled).toBe(false);
			expect(agent.disabled).toBe(false);
			expect(
				within(screen.getByRole("tabpanel")).queryByRole("status"),
			).toBeNull();
			await act(async () => fireEvent.click(selected));
			expect(create).toHaveBeenCalledTimes(2);
		},
	);
	it("chooses and persists a folder for every launch path without creating a session", async () => {
		const { api } = mount();
		mocks.pickFolder.mockResolvedValueOnce("/chosen folder");
		mocks.commitLayout.mockImplementationOnce(() => {
			expect(api.toJSON().panels["launcher:pick"].params?.cwd).toBe(
				"/chosen folder",
			);
			return true;
		});
		await act(async () =>
			fireEvent.click(
				screen.getByRole("button", { name: t("common.location") }),
			),
		);
		expect(mocks.pickFolder).toHaveBeenCalledWith({
			directory: true,
			multiple: false,
			defaultPath: "/repo",
			title: t("common.chooseWorkingFolder"),
		});
		expect(mocks.commitLayout).toHaveBeenCalledTimes(1);
		expect(mocks.terminal).not.toHaveBeenCalled();
		expect(mocks.quickAgent).not.toHaveBeenCalled();
		expect(useStore.getState().projects).toEqual(previous.projects);
		act(() => api.fromJSON(api.toJSON()));
		expect(
			screen.getByRole("button", { name: t("common.location") }).textContent,
		).toContain("/chosen folder");
		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: "터미널" })),
		);
		expect(mocks.terminal).toHaveBeenCalledWith(
			"desk-1",
			{ kind: "local", cwd: "/chosen folder" },
			{ replacement: api.getPanel("launcher:pick")!.api },
		);
		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: /^codex/ })),
		);
		expect(mocks.quickAgent).toHaveBeenCalledWith(
			"desk-1",
			{ label: "chosen folder", path: "/chosen folder" },
			"codex",
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: t("spaces.repository.addWithOptions"),
			}),
		);
		expect(screen.getByRole("dialog").dataset.path).toBe("/chosen folder");
	});
	it("lets a pane with no inherited cwd choose a folder", async () => {
		mount({});
		mocks.pickFolder.mockResolvedValueOnce("/chosen");
		await act(async () =>
			fireEvent.click(
				screen.getByRole("button", { name: t("common.location") }),
			),
		);
		expect(mocks.pickFolder).toHaveBeenCalledWith(
			expect.objectContaining({ defaultPath: undefined }),
		);
		fireEvent.click(screen.getByRole("button", { name: "claude" }));
		expect(mocks.quickAgent).toHaveBeenCalledWith(
			"desk-1",
			{ label: "chosen", path: "/chosen" },
			"claude",
		);
	});
	it("keeps the directory on cancel or picker failure and reports the error", async () => {
		const { api } = mount();
		mocks.pickFolder
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error("Picker unavailable"));
		for (let attempt = 0; attempt < 2; attempt++) {
			await act(async () =>
				fireEvent.click(
					screen.getByRole("button", { name: t("common.location") }),
				),
			);
			expect(api.toJSON().panels["launcher:pick"].params?.cwd).toBe("/repo");
		}
		expect(mocks.error).toHaveBeenCalledWith(
			t("common.folderOpenFailed", { e: "Error: Picker unavailable" }),
			{ paneId: "launcher:pick" },
		);
		expect(mocks.commitLayout).not.toHaveBeenCalled();
		expect(mocks.terminal).not.toHaveBeenCalled();
		expect(mocks.quickAgent).not.toHaveBeenCalled();
	});
	it("ignores a late picker result after the pane is replaced, even under the same ID", async () => {
		const { api } = mount();
		let finish!: (value: string) => void;
		mocks.pickFolder.mockReturnValueOnce(
			new Promise<string>((resolve) => {
				finish = resolve;
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: t("common.location") }));
		act(() => api.fromJSON(api.toJSON()));
		await act(async () => finish("/late"));
		expect(api.toJSON().panels["launcher:pick"].params?.cwd).toBe("/repo");
		expect(mocks.commitLayout).not.toHaveBeenCalled();
	});
	it("does not create a session until selected, then addresses this slot rather than current focus", async () => {
		const { api } = mount();
		expect(mocks.terminal).not.toHaveBeenCalled();
		expect(mocks.quickAgent).not.toHaveBeenCalled();
		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: "터미널" })),
		);
		expect(mocks.terminal).toHaveBeenCalledWith(
			"desk-1",
			{ kind: "local", cwd: "/repo" },
			{ replacement: api.getPanel("launcher:pick")!.api },
		);
	});
	it("searches the provider catalog and clears back to all choices", () => {
		const { api } = mount();
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "CoDeX" },
		});
		expect(screen.queryByRole("button", { name: "터미널" })).toBeNull();
		expect(screen.queryByRole("button", { name: "claude" })).toBeNull();
		const row = screen.getByRole("button", { name: /^codex/ });
		fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
		expect(document.activeElement).toBe(row);
		fireEvent.click(row);
		expect(mocks.quickAgent).toHaveBeenCalledWith(
			"desk-1",
			{ label: "repo", path: "/repo" },
			"codex",
		);
		expect(mocks.quickAdd).toHaveBeenLastCalledWith(
			expect.any(Function),
			{ replacement: api.getPanel("launcher:pick")!.api },
			"launcher:pick",
		);
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
		expect(screen.getByRole("button", { name: "터미널" })).toBeTruthy();
	});
	it("offers a recoverable no-match result", () => {
		mount();
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "not-a-provider" },
		});
		expect(
			within(screen.getByRole("tabpanel")).getByRole("status"),
		).toBeTruthy();
		expect(mocks.quickAgent).not.toHaveBeenCalled();
	});
	it("keeps the selector on dialog cancel and places successful creation in the same slot", async () => {
		const { api } = mount({});
		fireEvent.click(screen.getByRole("button", { name: "claude" }));
		expect(screen.getByRole("dialog").dataset.provider).toBe("claude");
		fireEvent.click(screen.getByRole("button", { name: "Cancel creation" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(mocks.agent).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "claude" }));
		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: "Finish creation" })),
		);
		expect(mocks.agent).toHaveBeenCalledWith(
			"desk-1",
			{ id: "new-agent" },
			{ replacement: api.getPanel("launcher:pick")!.api },
		);
	});
	it("preserves the inherited SSH host for both terminal and agent selection", async () => {
		useStore.setState({
			sshHosts: [
				{
					id: "ssh-1",
					name: "Remote",
					host: "example.test",
					user: "test",
					port: 22,
					auth: "auto",
				},
			],
		});
		const { api } = mount({ hostId: "ssh-1", cwd: "/srv/repo" });
		expect(
			screen.queryByRole("button", { name: t("common.location") }),
		).toBeNull();
		expect(mocks.pickFolder).not.toHaveBeenCalled();
		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: "터미널" })),
		);
		expect(mocks.terminal).toHaveBeenCalledWith(
			"desk-1",
			{ kind: "ssh", hostId: "ssh-1", cwd: "/srv/repo" },
			{ replacement: api.getPanel("launcher:pick")!.api },
		);
		fireEvent.click(screen.getByRole("button", { name: "claude" }));
		expect(mocks.quickAgent).toHaveBeenCalledWith(
			"desk-1",
			{ label: "repo", path: "/srv/repo", hostId: "ssh-1" },
			"claude",
		);
	});
	it("does not silently launch locally when an inherited SSH host was removed", () => {
		mount({ hostId: "missing", cwd: "/srv/repo" });
		expect(
			within(screen.getByRole("tabpanel")).getByRole("alert"),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "터미널" })).toBeNull();
		expect(mocks.quickAgent).not.toHaveBeenCalled();
		expect(mocks.terminal).not.toHaveBeenCalled();
	});
});
