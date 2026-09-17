// @vitest-environment jsdom
//
// Pane-level contracts:
// - the list hierarchy follows uiPrefs.spacesViewOptions — repositories first
//   with the spaces holding their panes nested (default), or spaces first
//   with repositories nested, or runtime facets above that same hierarchy —
//   and the view-options menu switches it,
// - a repository head row folds its group and the fold is remembered,
// - attention rolls up onto the leading heading regardless of the search,
// - repository containers bail out of unrelated pane re-renders (observed
//   through repositoryRemoteHostId, which runs once per head-row render),
// - an attention event re-derives the unopened list with one exact conversation
//   lookup per candidate instead of one per sort comparison,
// - a row dragged onto a space heading moves its pane there, and only the
//   hovered section lights up.
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { Profiler } from "react";
import { createDockview } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConversationRecord } from "@/lib/agents/providerConversationDiscovery";
import { endSpacesRowDrag } from "@/lib/spaces/spacesDrag";
import type { Agent, Project } from "@/types";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { prepareAgentRemoval, executeAgentRemoval } from "@/lib/agents/resourceLifecycle";
import { registerDockview, unregisterDockview } from "@/lib/workspace/dock/dockRegistry";
import { agentRemovalRegistrationIdentity } from "@/lib/agents/agentRemovalRegistration";
vi.mock("@/lib/agents/resourceLifecycle", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/agents/resourceLifecycle")>(),
  prepareAgentRemoval: vi.fn(),
  executeAgentRemoval: vi.fn(),
}));

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	ask: vi.fn(),
	confirm: vi.fn(),
	message: vi.fn(),
	open: vi.fn(),
}));
vi.mock("@/lib/workspace/dock/openScmPanel", () => ({
	openGitPanel: vi.fn(),
	openDiffPanel: vi.fn(),
	openSessionDiffPanel: vi.fn(),
}));
vi.mock("@/lib/workspace/dock", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/workspace/dock")>();
	const { getDragState, setDragState } = await import(
		"@/lib/workspace/pane/paneDragState"
	);
	const movePanelsToDesktop = vi.fn();
	return {
		...original,
		movePanelsToDesktop,
		// Mirrors the real helper: the pane-tab drag is spent, then moved.
		movePanelToDesktop: vi.fn((targetDesktopId: string) => {
			const drag = getDragState();
			setDragState(null);
			if (!drag || drag.fromDesktopId === targetDesktopId) return;
			void movePanelsToDesktop([drag], targetDesktopId);
		}),
		openAgentPanel: vi.fn(),
		openInheritedTerminalOn: vi.fn(),
		withDesktopDockview: vi.fn(),
	};
});
vi.mock("@/lib/workspace/dock/panelFocusHandoff", () => ({
	navigateToPanel: vi.fn(),
}));
vi.mock("@/lib/workspace/pane/paneCloseCoordinator", () => ({
	killPanels: vi.fn(),
}));
vi.mock("@/lib/workspace/window/windows", () => ({
	openAgentDiffWindow: vi.fn(),
}));
vi.mock("@/lib/agents/agentRemovalDialog", () => ({
	openAgentRemovalDialog: vi.fn(),
}));
vi.mock("@/lib/agents/agentInstalls", () => ({
	useAvailableProviders: () => ["claude", "codex"],
	useQuickStartProviders: (limit: number) => ({
		available: ["claude", "codex"],
		quick: ["claude", "codex"].slice(0, limit),
	}),
}));

const providerConversationMocks = vi.hoisted(() => ({
	list: vi.fn<() => Promise<ProviderConversationRecord[]>>(async () => []),
}));

vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	listProviderConversations: providerConversationMocks.list,
}));
vi.mock("@/lib/spaces/spaceRepositoryGroups", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/lib/spaces/spaceRepositoryGroups")>();
	return {
		...original,
		repositoryRemoteHostId: vi.fn(original.repositoryRemoteHostId),
	};
});
vi.mock("@/lib/spaces/unopenedAgentPresentation", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@/lib/spaces/unopenedAgentPresentation")
		>();
	return {
		...original,
		unopenedAgentConversation: vi.fn(original.unopenedAgentConversation),
	};
});

import { activityLabel } from "@/components/agents/StatusBits";
import { SpacesPane } from "@/components/spaces/SpacesPane";
import { publishConversationMetadata } from "@/lib/agents/chat/conversationPresentationState";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { t } from "@/lib/i18n";
import { resetRecentSessionHistoryForTests } from "@/lib/sessions/recentSessionHistoryResource";
import { repositoryRemoteHostId } from "@/lib/spaces/spaceRepositoryGroups";
import { useSpacesCollapsedGroups } from "@/lib/spaces/spacesCollapsedGroupsStore";
import { useSpacesPaneUi } from "@/lib/spaces/spacesPaneUiStore";
import { unopenedAgentConversation } from "@/lib/spaces/unopenedAgentPresentation";
import {
	DEFAULT_SPACES_VIEW_OPTIONS,
	type SpacesGrouping,
} from "@/lib/spaces/spacesViewOptions";
import { movePanelsToDesktop, withDesktopDockview } from "@/lib/workspace/dock";
import { useUnopenedAgentVisibilityStore } from "@/lib/spaces/unopenedAgentVisibilityStore";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { useHiddenFilePanes } from "@/lib/workspace/pane/hiddenFilePanesStore";
import {
	getDragState,
	setDragState,
} from "@/lib/workspace/pane/paneDragState";
import { useStore } from "@/store";
import { panePinKey } from "@/lib/workspace/pane/panePin";

const remoteHostIdCalls = () =>
	vi.mocked(repositoryRemoteHostId).mock.calls.length;
const conversationLookupCalls = () =>
	vi.mocked(unopenedAgentConversation).mock.calls.length;

const PROJECTS: Project[] = [
	{
		id: "p1",
		name: "Repo One",
		path: "/repo-one",
		kind: "local",
		isRepo: true,
	},
	{
		id: "p2",
		name: "Repo Two",
		path: "/repo-two",
		kind: "local",
		isRepo: true,
	},
];

/** The pane title authority shows the name the user chose (`displayName`);
 *  a bare registry name falls back to the worktree folder. */
function makeAgent(id: string, projectId: string, name: string): Agent {
	return {
		id,
		name: id,
		displayName: name,
		provider: "claude",
		projectId,
		worktreePath: `${projectId === "p1" ? "/repo-one" : "/repo-two"}/wt-${id}`,
		branch: `agent/${id}`,
		sessionId: `session-${id}`,
		sessionKind: "pty",
	};
}

const DESKTOPS = [
	{ id: "desk-1", name: "One" },
	{ id: "desk-2", name: "Two" },
	{ id: "desk-3", name: "Three" },
];

function agentPane(agentId: string) {
	return { contentComponent: "agent", params: { agentRef: { agentId } } };
}

function seedStore() {
	useStore.setState({
		spaces: DESKTOPS,
		desktops: DESKTOPS,
		activeSpaceId: "desk-1",
		activeDesktopId: "desk-1",
		projects: PROJECTS,
		// Pins leak across tests otherwise — a pinned repository reorders the
		// list every test after the one that pinned it.
		pinnedProjects: [],
		agents: [
			makeAgent("agent-a", "p1", "Alpha Open"),
			makeAgent("agent-b", "p2", "Bravo Open"),
			makeAgent("agent-u1", "p1", "U Alpha"),
			makeAgent("agent-u2", "p1", "U Bravo"),
			makeAgent("agent-u3", "p2", "U Charlie"),
		],
		layouts: {
			"desk-1": { panels: { "agent:agent-a": agentPane("agent-a") } },
			"desk-2": { panels: { "agent:agent-b": agentPane("agent-b") } },
		},
	});
}

function setGroupBy(groupBy: SpacesGrouping) {
	useStore.setState((state) => ({
		uiPrefs: {
			...state.uiPrefs,
			spacesViewOptions: { ...state.uiPrefs.spacesViewOptions, groupBy },
		},
	}));
}

function dragDataTransfer() {
	const values = new Map<string, string>();
	return {
		effectAllowed: "none",
		dropEffect: "none",
		getData: vi.fn((type: string) => values.get(type) ?? ""),
		setData: vi.fn((type: string, value: string) => values.set(type, value)),
		setDragImage: vi.fn(),
	} as unknown as DataTransfer;
}

const REPO_ONE_KEY = '["project","p1"]';

// The fold store starts with the unopened queue folded; these tests reason
// about a fully open list unless they say otherwise.
beforeEach(() => {
	useSpacesCollapsedGroups.setState({ collapsed: {} });
});

afterEach(() => {
	cleanup();
	endSpacesRowDrag();
	resetRecentSessionHistoryForTests();
	useStore.setState((state) => ({
		layouts: {},
		projects: [],
		pinnedPanes: {},
		agents: [],
		detected: {},
		uiPrefs: {
			...state.uiPrefs,
			spacesViewOptions: DEFAULT_SPACES_VIEW_OPTIONS,
		},
	}));
	useAgentAttention.setState({ episodes: {}, acks: {}, displayStates: {} });
	useSpacesPaneUi.setState({ query: "" });
	useSpacesCollapsedGroups.setState({ collapsed: {} });
	useHiddenFilePanes.setState({ hidden: {} });
	useHiddenPanes.setState({ hidden: {} });
	useUnopenedAgentVisibilityStore.setState({ hidden: [] });
	useStore.setState({ agentActivity: {} });
	useStore.setState({ focusCtx: null });
	setDragState(null);
	vi.clearAllMocks();
	vi.mocked(invoke).mockReset();
	providerConversationMocks.list.mockResolvedValue([]);
});

describe("SpacesPane hierarchy", () => {
	it("does not commit the complete pane for geometry-only layout writes", async () => {
		seedStore();
		const onRender = vi.fn();
		render(
			<Profiler id="spaces" onRender={onRender}>
				<SpacesPane />
			</Profiler>,
		);
		await act(async () => {
			await Promise.resolve();
		});
		const before = onRender.mock.calls.length;
		for (let index = 0; index < 32; index += 1) {
			act(() =>
				useStore.getState().saveLayout("desk-1", {
					grid: { width: 1200 + index, height: 800 },
					panels: { "agent:agent-a": agentPane("agent-a") },
				}),
			);
		}
		expect(screen.getByText("Alpha Open")).toBeTruthy();
		expect(screen.getByText("U Alpha")).toBeTruthy();
		expect(onRender.mock.calls.length - before).toBe(0);
		act(() =>
			useStore.setState((state) => ({
				agents: state.agents.map((agent) =>
					agent.id === "agent-a"
						? { ...agent, displayName: "Updated Alpha" }
						: agent,
				),
			})),
		);
		expect(screen.getByText("Updated Alpha")).toBeTruthy();
		expect(onRender.mock.calls.length).toBeGreaterThan(before);
	});

	it("recovers a persisted empty search into a direct folder picker without a management dialog", async () => {
		seedStore();
		vi.mocked(openDialog).mockResolvedValueOnce(null);
		useStore.setState({ projects: [], agents: [], layouts: {}, detected: {} });
		useSpacesPaneUi.setState({ query: "old search" });
		render(<SpacesPane />);

		const search = screen.getByRole("textbox", {
			name: t("spaces.pane.searchPlaceholder"),
		});
		expect((search as HTMLInputElement).value).toBe("old search");
		expect(
			screen.queryByRole("button", { name: t("spaces.empty.addFolder") }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: t("common.clearSearch") }));
		expect(screen.queryByRole("textbox")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: t("spaces.empty.addFolder") }),
		);
		await waitFor(() => expect(openDialog).toHaveBeenCalledWith({
			directory: true,
			multiple: false,
			title: t("common.chooseWorkingFolder"),
		}));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(useStore.getState().projects).toEqual([]);
		expect(screen.getByRole("button", { name: t("spaces.empty.addFolder") })).toBeTruthy();
	});

	it.each(["repository", "space"] as const)("shows the first selected folder in %s grouping and keeps project management available", async (groupBy) => {
		seedStore();
		setGroupBy(groupBy);
		useStore.setState({ projects: [], agents: [], layouts: {}, detected: {} });
		vi.mocked(openDialog).mockResolvedValueOnce("/work/first-folder");
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "inspect_local_directory") return (args as { path: string }).path;
			if (command === "git_status") return { isRepo: false };
			return undefined;
		});
		render(<SpacesPane />);

		fireEvent.click(screen.getByRole("button", { name: t("spaces.empty.addFolder") }));
		await screen.findByText("first-folder");
		expect(useStore.getState().projects).toEqual([
			expect.objectContaining({ path: "/work/first-folder", kind: "local" }),
		]);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("button", { name: t("spaces.empty.addFolder") })).toBeNull();

		fireEvent.pointerDown(screen.getByRole("button", { name: t("spaces.locations.add") }), {
			button: 0,
			ctrlKey: false,
		});
		fireEvent.click(await screen.findByRole("menuitem", { name: t("spaces.locations.manage") }));
		expect(await screen.findByRole("dialog", { name: t("spaces.locations.manage") })).toBeTruthy();
		expect(openDialog).toHaveBeenCalledOnce();
	});

	it("reveals a selected local folder beside a same-named SSH repository in Space grouping", async () => {
		seedStore();
		setGroupBy("space");
		useStore.setState((state) => ({
			projects: [{ ...PROJECTS[0], name: "dure-internal", kind: "ssh", sshHostId: "remote" }, PROJECTS[1]],
			agents: state.agents.slice(0, 2),
		}));
		const layouts = useStore.getState().layouts;
		vi.mocked(openDialog).mockResolvedValueOnce("/work/dure-internal");
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "inspect_local_directory") return (args as { path: string }).path;
			if (command === "git_status") return { isRepo: false };
			return undefined;
		});
		const { container } = render(<SpacesPane />);
		fireEvent.pointerDown(screen.getByRole("button", { name: t("spaces.locations.add") }), {
			button: 0, ctrlKey: false,
		});
		fireEvent.click(await screen.findByRole("menuitem", { name: t("spaces.locations.openLocalFolder") }));

		await waitFor(() => expect(screen.getAllByRole("region", { name: "dure-internal" })).toHaveLength(2));
		const local = screen.getAllByRole("region", { name: "dure-internal" })
			.find((region) => within(region).queryByText(t("spaces.repository.noSessions")));
		if (!local) throw new Error("selected folder did not appear without a session");
		expect(local.closest("[data-space-desktop-section]")).toBeNull();
		expect(useStore.getState().uiPrefs.spacesViewOptions.groupBy).toBe("space");
		expect(useStore.getState().layouts).toEqual(layouts);
		expect(useStore.getState().projects).toEqual([
			expect.objectContaining({ id: "p1", kind: "ssh", sshHostId: "remote" }),
			PROJECTS[1],
			expect.objectContaining({ path: "/work/dure-internal", kind: "local" }),
		]);
		fireEvent.click(within(local).getByRole("button", { name: t("common.openTerminal") }));
		expect(withDesktopDockview).toHaveBeenCalledWith("desk-1", expect.any(Function));
		expect(container.querySelectorAll('[data-space-desktop-section="desk-1"]')).toHaveLength(1);
	});

	it("uses the exact provider thread title and activity time for an unopened agent", async () => {
		const now = Date.now();
		seedStore();
		useStore.setState((state) => ({
			agents: state.agents.map((agent) =>
				agent.id === "agent-u1"
					? {
						...agent,
						displayName: undefined,
						conversationId: "conversation-u1",
					}
					: agent,
			),
		}));
		providerConversationMocks.list.mockResolvedValue([
			{
				provider: "claude",
				id: "conversation-u1",
				cwd: "/repo-one/wt-agent-u1",
				title: "Review the reconnect lifecycle",
				mtime: now / 1000,
				resumeCapability: "exact",
				executionLocation: "local",
			},
		]);

		render(<SpacesPane />);

		expect(
			await screen.findByText("Review the reconnect lifecycle"),
		).toBeTruthy();
		expect(screen.queryByText("2시간 전")).toBeNull();
		act(() => publishConversationMetadata("agent-u1", "conversation-u1", {
			title: "Review the reconnect lifecycle",
			activityAt: new Date(now - 2 * 60 * 60 * 1_000).toISOString(),
		}));
		expect(screen.getByText("2시간 전")).toBeTruthy();
	});

	it("leads with repositories and nests the spaces holding their panes by default", () => {
		seedStore();
		const { container } = render(<SpacesPane />);

		const repoOne = screen.getByRole("region", { name: "Repo One" });
		// The space heading sits inside the repository, one level down.
		expect(
			within(repoOne).getByRole("heading", { level: 4, name: "One" }),
		).toBeTruthy();
		expect(within(repoOne).getByText("Alpha Open")).toBeTruthy();
		expect(
			within(screen.getByRole("region", { name: "Repo Two" })).getByText(
				"Bravo Open",
			),
		).toBeTruthy();
		// Repositories are the top-level headings; no space heads the list.
		expect(
			[...container.querySelectorAll("h3")].map((node) => node.textContent),
		).toEqual(["Repo One", "Repo Two", t("spaces.pane.unopenedAgents")]);
		// An empty space has no repository to sit under and is not listed.
		expect(container.querySelector('[data-desktop-id="desk-3"]')).toBeNull();
		expect(screen.getByText("U Alpha")).toBeTruthy();
	});

	it("leads with spaces and nests repositories when the preference says so", () => {
		seedStore();
		setGroupBy("space");
		const { container } = render(<SpacesPane />);

		expect(
			container.querySelector(
				'[data-space-desktop-section="desk-1"] [data-space-repository-group]',
			),
		).toBeTruthy();
		expect(
			[...container.querySelectorAll("h3")].map((node) => node.textContent),
		).toEqual(["One", "Two", "Three", t("spaces.pane.unopenedAgents")]);
		expect(screen.getByText("Alpha Open")).toBeTruthy();
	});

	it("switches the hierarchy from the dedicated view-options menu", async () => {
		seedStore();
		render(<SpacesPane />);

		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.pointerMove(
			await screen.findByRole("menuitem", {
				name: t("spaces.pane.grouping"),
			}),
			{ pointerType: "mouse" },
		);
		const spaceOption = await screen.findByRole("menuitemradio", {
			name: t("common.space"),
		});
		expect(
			screen.getByRole("menuitemradio", {
				name: t("spaces.pane.groupByRepository"),
			}).getAttribute("aria-checked"),
		).toBe("true");
		fireEvent.click(spaceOption);

		expect(useStore.getState().uiPrefs.spacesViewOptions.groupBy).toBe("space");
	});

	it("filters open rows from the canonical Status facet and marks the trigger", async () => {
		seedStore();
		useAgentAttention.setState({
			displayStates: { "agent-a": "blocked", "agent-b": "working" },
		});
		setGroupBy("status");
		render(<SpacesPane />);

		const trigger = screen.getByRole("button", {
			name: t("spaces.pane.viewOptions"),
		});
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
		fireEvent.pointerMove(
			screen.getByRole("menuitem", { name: t("spaces.pane.status") }),
			{ pointerType: "mouse" },
		);
		fireEvent.click(
			await screen.findByRole("menuitemcheckbox", {
				name: t("agents.status.approvalRequired"),
			}),
		);

		await waitFor(() => {
			expect(screen.getByText("Alpha Open")).toBeTruthy();
			expect(screen.queryByText("Bravo Open")).toBeNull();
			expect(
				document.querySelector('[data-spaces-facet-group="status:blocked"]'),
			).toBeTruthy();
			expect(
				document.querySelector('[data-spaces-facet-group="status:working"]'),
			).toBeNull();
			expect(
				useStore.getState().uiPrefs.spacesViewOptions.filters.status,
			).toEqual(["blocked"]);
			expect(
				screen
					.getByRole("button", { name: t("spaces.pane.viewOptions") })
					.getAttribute("data-active-filters"),
			).toBe("true");
		});
	});

	it("orders open rows by their authoritative activity time when selected", () => {
		seedStore();
		useStore.setState((state) => ({
			layouts: {
				"desk-1": {
					panels: {
						"agent:agent-a": agentPane("agent-a"),
						"agent:agent-b": agentPane("agent-b"),
					},
				},
			},
			sessionActivity: {
				"session-agent-a": { text: "Older", at: 1_000 },
				"session-agent-b": { text: "Newer", at: 2_000 },
			},
			uiPrefs: {
				...state.uiPrefs,
				spacesViewOptions: {
					...state.uiPrefs.spacesViewOptions,
					groupBy: "space",
					orderBy: "updated",
				},
			},
		}));
		const { container } = render(<SpacesPane />);

		expect(
			[...container.querySelectorAll("[data-space-key]")].map((row) =>
				row.getAttribute("data-space-key"),
			),
		).toEqual(["agent:agent-b", "agent:agent-a"]);
	});

	it("groups status facets over the existing repository and space hierarchy", () => {
		seedStore();
		useAgentAttention.setState({
			displayStates: { "agent-a": "blocked", "agent-b": "working" },
		});
		setGroupBy("status");
		const { container } = render(<SpacesPane />);

		const blocked = container.querySelector(
			'[data-spaces-facet-group="status:blocked"]',
		);
		const working = container.querySelector(
			'[data-spaces-facet-group="status:working"]',
		);
		expect(blocked).toBeTruthy();
		expect(working).toBeTruthy();
		expect(
			within(blocked as HTMLElement).getByRole("heading", {
				level: 3,
				name: activityLabel("blocked"),
			}),
		).toBeTruthy();
		expect(
			within(blocked as HTMLElement).getByRole("heading", {
				level: 4,
				name: "Repo One",
			}),
		).toBeTruthy();
		expect(
			within(blocked as HTMLElement).getByRole("heading", {
				level: 5,
				name: "One",
			}),
		).toBeTruthy();
		expect(within(blocked as HTMLElement).getByText("Alpha Open")).toBeTruthy();
		expect(within(working as HTMLElement).getByText("Bravo Open")).toBeTruthy();
		expect(
			within(blocked as HTMLElement).getByRole("region", {
				name: `${activityLabel("blocked")} Repo One`,
			}),
		).toBeTruthy();
		expect(
			within(blocked as HTMLElement).getByLabelText(
				t("spaces.group.attentionCount", { n: 1 }),
			),
		).toBeTruthy();
	});

	it("groups Local and SSH environments without repeating the heading in rows", () => {
		seedStore();
		useStore.setState((state) => ({
			projects: [
				...PROJECTS,
				{
					id: "p-remote",
					name: "Remote Repo",
					path: "/srv/repo",
					kind: "ssh",
					sshHostId: "host-1",
					isRepo: true,
				},
			],
			sshHosts: [
				{
					id: "host-1",
					name: "builder",
					host: "builder.example",
					port: 22,
					user: "dev",
					auth: "auto",
				},
			],
			agents: state.agents.map((agent) =>
				agent.id === "agent-b"
					? {
							...agent,
							projectId: "p-remote",
							worktreePath: "/srv/repo/.worktrees/agent-b",
							sessionKind: "ssh",
						}
					: agent,
			),
		}));
		setGroupBy("environment");
		const { container } = render(<SpacesPane />);

		const local = container.querySelector(
			'[data-spaces-facet-group="environment:local"]',
		);
		const ssh = container.querySelector(
			'[data-spaces-facet-group="environment:ssh"]',
		);
		if (!(local instanceof HTMLElement) || !(ssh instanceof HTMLElement)) {
			throw new Error("environment facets did not render");
		}
		expect(
			within(local).getByRole("heading", {
				level: 3,
				name: t("spaces.pane.environmentLocal"),
			}),
		).toBeTruthy();
		expect(within(local).getByText("Alpha Open")).toBeTruthy();
		expect(within(ssh).getByText("Bravo Open")).toBeTruthy();
		const remoteRow = ssh.querySelector(
			'[data-space-key="agent:agent-b"]',
		);
		if (!(remoteRow instanceof HTMLElement)) {
			throw new Error("remote row did not render");
		}
		expect(
			within(remoteRow).queryByText(t("spaces.pane.environmentSsh")),
		).toBeNull();
	});

	it("keeps an unregistered folder visible in its exact Location group", () => {
		seedStore();
		useStore.setState({
			layouts: {
				"desk-1": {
					panels: {
						"agent:agent-a": agentPane("agent-a"),
						"term:term-scratch": {
							contentComponent: "terminal",
							params: { sessionId: "term-scratch", cwd: "/scratch/lab" },
						},
					},
				},
				"desk-2": { panels: { "agent:agent-b": agentPane("agent-b") } },
			},
		});
		setGroupBy("location");
		const { container } = render(<SpacesPane />);

		const heading = screen.getByRole("heading", {
			level: 3,
			name: "/scratch/lab",
		});
		const group = heading.closest("[data-spaces-facet-group]");
		expect(group).toBeTruthy();
		const scratchRow = group?.querySelector(
			'[data-space-key="term:term-scratch"]',
		);
		expect(scratchRow).toBeTruthy();
		expect(scratchRow?.textContent).not.toContain("scratch/lab");
		expect(container.querySelectorAll("[data-space-key]")).toHaveLength(3);
	});

	it("moves an updated facet across local midnight without remounting", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(2026, 8, 4, 23, 59, 45));
			seedStore();
			useStore.setState((state) => ({
				sessionActivity: {
					...state.sessionActivity,
					"session-agent-a": {
						text: "Earlier today",
						at: new Date(2026, 8, 4, 12).getTime(),
					},
				},
			}));
			setGroupBy("updated");
			const { container } = render(<SpacesPane />);

			const today = container.querySelector(
				'[data-spaces-facet-group="updated:today"]',
			);
			if (!(today instanceof HTMLElement))
				throw new Error("today facet did not render");
			expect(within(today).getByText("Alpha Open")).toBeTruthy();

			act(() => {
				vi.advanceTimersByTime(30_300);
			});

			const yesterday = container.querySelector(
				'[data-spaces-facet-group="updated:yesterday"]',
			);
			if (!(yesterday instanceof HTMLElement)) {
				throw new Error("yesterday facet did not render after midnight");
			}
			expect(within(yesterday).getByText("Alpha Open")).toBeTruthy();
		} finally {
			cleanup();
			vi.useRealTimers();
		}
	});

	it("collapses facet groups and then offers the inverse bulk action", async () => {
		seedStore();
		useAgentAttention.setState({
			displayStates: { "agent-a": "blocked", "agent-b": "working" },
		});
		setGroupBy("status");
		render(<SpacesPane />);

		const openViewOptions = () =>
			fireEvent.pointerDown(
				screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
				{ button: 0, ctrlKey: false },
			);
		openViewOptions();
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: t("spaces.pane.collapseAll"),
			}),
		);

		expect(screen.queryByText("Alpha Open")).toBeNull();
		expect(screen.queryByText("Bravo Open")).toBeNull();
		expect(useSpacesCollapsedGroups.getState().collapsed).toMatchObject({
			'["facet","status","blocked"]': true,
			'["facet","status","working"]': true,
		});

		openViewOptions();
		expect(
			await screen.findByRole("menuitem", {
				name: t("spaces.pane.expandAll"),
			}),
		).toBeTruthy();
	});

	it("collapses and expands only the repository groups visible in this view", async () => {
		seedStore();
		useSpacesCollapsedGroups.setState({ collapsed: { unseen: true } });
		render(<SpacesPane />);

		const openViewOptions = () =>
			fireEvent.pointerDown(
				screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
				{ button: 0, ctrlKey: false },
			);
		openViewOptions();
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: t("spaces.pane.collapseAll"),
			}),
		);

		expect(screen.queryByText("Alpha Open")).toBeNull();
		expect(screen.queryByText("Bravo Open")).toBeNull();
		// Every fold in view: the open groups, the unopened section, and its
		// own repository groups — never a key outside this projection.
		expect(useSpacesCollapsedGroups.getState().collapsed).toEqual({
			unseen: true,
			[REPO_ONE_KEY]: true,
			'["project","p2"]': true,
			unopened: true,
			[`unopened ${REPO_ONE_KEY}`]: true,
			'unopened ["project","p2"]': true,
		});

		openViewOptions();
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: t("spaces.pane.expandAll"),
			}),
		);
		expect(screen.getByText("Alpha Open")).toBeTruthy();
		expect(screen.getByText("Bravo Open")).toBeTruthy();
		expect(useSpacesCollapsedGroups.getState().collapsed).toEqual({ unseen: true });
	});

	it("offers expand when every visible group is collapsed", async () => {
		seedStore();
		useSpacesCollapsedGroups.setState({
			collapsed: {
				[REPO_ONE_KEY]: true,
				'["project","p2"]': true,
				unopened: true,
			},
		});
		render(<SpacesPane />);

		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);

		expect(
			screen.queryByRole("menuitem", { name: t("spaces.pane.collapseAll") }),
		).toBeNull();
		expect(
			await screen.findByRole("menuitem", {
				name: t("spaces.pane.expandAll"),
			}),
		).toBeTruthy();
	});

	it.each(["repository", "space"] as const)("includes empty repositories in the %s bulk fold state", async (groupBy) => {
		seedStore();
		setGroupBy(groupBy);
		useStore.setState((state) => ({
			projects: [
				...state.projects,
				{
					id: "p-empty",
					name: "Empty Repo",
					path: "/empty-repo",
					kind: "local" as const,
					isRepo: true,
				},
			],
		}));
		useSpacesCollapsedGroups.setState({
			collapsed: {
				[REPO_ONE_KEY]: true,
				'["project","p2"]': true,
				unopened: true,
			},
		});
		render(<SpacesPane />);
		const emptyRepository = screen.getByRole("region", { name: "Empty Repo" });
		expect(
			within(emptyRepository)
				.getByRole("button", { name: "Empty Repo" })
				.getAttribute("aria-expanded"),
		).toBe("true");
		expect(
			within(emptyRepository).getByText(t("spaces.repository.noSessions")),
		).toBeTruthy();

		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);

		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: t("spaces.pane.collapseAll"),
			}),
		);

		expect(
			within(emptyRepository).queryByText(t("spaces.repository.noSessions")),
		).toBeNull();
		expect(useSpacesCollapsedGroups.getState().collapsed).toMatchObject({
			'["project","p-empty"]': true,
		});
	});

	it("renders repositories first when the stored preference is not a known value", () => {
		seedStore();
		// The CLI can write a malformed object; the store boundary must normalize
		// it before the pane can observe an impossible grouping.
		useStore.getState().setUiPrefs({
			spacesViewOptions: { groupBy: "bogus" } as never,
		});
		const { container } = render(<SpacesPane />);

		expect(
			[...container.querySelectorAll("h3")].map((node) => node.textContent),
		).toEqual(["Repo One", "Repo Two", t("spaces.pane.unopenedAgents")]);
	});

	it("lists a space holding only hidden file panes after the repositories and hides it under a search", () => {
		seedStore();
		useHiddenFilePanes.setState({
			hidden: {
				"file:/notes/todo.md": {
					desktopId: "desk-3",
					at: 1,
					file: { path: "/notes/todo.md", source: "local" },
				},
			},
		});
		const { container } = render(<SpacesPane />);
		expect(
			container.querySelector('[data-space-desktop-section="desk-3"]'),
		).toBeTruthy();

		act(() => {
			useSpacesPaneUi.getState().setQuery("Bravo");
		});

		// Space-first hides a space the search leaves empty; project-first
		// must hide its hidden-file section the same way.
		expect(
			container.querySelector('[data-space-desktop-section="desk-3"]'),
		).toBeNull();
		expect(screen.getByText("Bravo Open")).toBeTruthy();
	});

	it("folds a repository from its head row and remembers the fold", () => {
		seedStore();
		render(<SpacesPane />);
		const repoOne = screen.getByRole("region", { name: "Repo One" });
		// Named, not just "the expanded button in here": a space section nested
		// under this repository now carries a fold chevron of its own
		// (2026-09-08), so the region holds more than one.
		const toggle = within(repoOne).getByRole("button", {
			name: "Repo One",
			expanded: true,
		});

		fireEvent.click(toggle);

		expect(within(repoOne).queryByText("Alpha Open")).toBeNull();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(useSpacesCollapsedGroups.getState().collapsed).toEqual({
			[REPO_ONE_KEY]: true,
		});
		// The other repository is untouched.
		expect(screen.getByText("Bravo Open")).toBeTruthy();

		fireEvent.click(toggle);
		expect(within(repoOne).getByText("Alpha Open")).toBeTruthy();
	});

	it("keeps the fold across hierarchies — a folded repository stays folded under a space", () => {
		seedStore();
		useSpacesCollapsedGroups.setState({ collapsed: { [REPO_ONE_KEY]: true } });
		setGroupBy("space");
		render(<SpacesPane />);

		expect(screen.queryByText("Alpha Open")).toBeNull();
		expect(screen.getByText("Bravo Open")).toBeTruthy();
	});

	it("rolls attention up onto the repository heading regardless of the search", () => {
		seedStore();
		// A second Repo One pane keeps the repository listed while the search
		// hides the row that needs attention.
		useStore.setState((state) => ({
			agents: [...state.agents, makeAgent("agent-a2", "p1", "Alpha Two")],
			layouts: {
				...state.layouts,
				"desk-1": {
					panels: {
						"agent:agent-a": agentPane("agent-a"),
						"agent:agent-a2": agentPane("agent-a2"),
					},
				},
			},
		}));
		useAgentAttention.setState({ displayStates: { "agent-a": "blocked" } });
		useSpacesPaneUi.setState({ query: "alpha two" });
		render(<SpacesPane />);

		const repoOne = screen.getByRole("region", { name: "Repo One" });
		expect(within(repoOne).queryByText("Alpha Open")).toBeNull();
		expect(within(repoOne).getByText("Alpha Two")).toBeTruthy();
		expect(
			within(repoOne).getByLabelText(
				t("spaces.group.attentionCount", { n: 1 }),
			),
		).toBeTruthy();
	});

	const REPO_THREE: Project = {
		id: "p3",
		name: "Repo Three",
		path: "/repo-three",
		kind: "local",
		isRepo: true,
	};

	it("keeps non-row surfaces outside runtime facets", () => {
		seedStore();
		useStore.setState({
			projects: [...PROJECTS, REPO_THREE],
			pinnedProjects: ["p2"],
		});
		useAgentAttention.setState({
			displayStates: { "agent-a": "working", "agent-b": "blocked" },
		});
		useHiddenFilePanes.setState({
			hidden: {
				"file:/notes/todo.md": {
					desktopId: "desk-3",
					at: 1,
					file: { path: "/notes/todo.md", source: "local" },
				},
			},
		});
		setGroupBy("status");
		const { container } = render(<SpacesPane />);

		const facets = [...container.querySelectorAll("[data-spaces-facet-group]")];
		expect(
			container.querySelector('[data-spaces-facet-group="status:unknown"]'),
		).toBeNull();
		const band = container.querySelector("[data-spaces-pinned]");
		const emptyRepository = screen.getByRole("region", { name: "Repo Three" });
		const hiddenDesktop = container.querySelector(
			'[data-space-desktop-section="desk-3"]',
		);
		if (!(band instanceof HTMLElement) || !hiddenDesktop) {
			throw new Error("facet trailing-surface fixture did not render");
		}
		expect(within(band).getByText("Bravo Open")).toBeTruthy();
		expect(
			within(band).getByLabelText(t("spaces.group.attentionCount", { n: 1 })),
		).toBeTruthy();
		expect(facets.every((facet) => !facet.contains(emptyRepository))).toBe(
			true,
		);
		expect(facets.every((facet) => !facet.contains(hiddenDesktop))).toBe(true);

		act(() => {
			useSpacesPaneUi.getState().setQuery("No such space");
		});
		expect(container.querySelector("[data-spaces-pinned]")).toBeTruthy();
		expect(screen.queryByRole("region", { name: "Repo Three" })).toBeNull();
		expect(
			container.querySelector('[data-space-desktop-section="desk-3"]'),
		).toBeNull();
	});

	it("separates trailing facet surfaces from the unopened queue", () => {
		seedStore();
		useStore.setState({
			projects: [...PROJECTS, REPO_THREE],
			layouts: {},
		});
		useHiddenFilePanes.setState({
			hidden: {
				"file:/notes/todo.md": {
					desktopId: "desk-3",
					at: 1,
					file: { path: "/notes/todo.md", source: "local" },
				},
			},
		});
		setGroupBy("status");
		const { container } = render(<SpacesPane />);

		expect(container.querySelector("[data-spaces-facet-group]")).toBeNull();
		expect(screen.getByRole("region", { name: "Repo Three" })).toBeTruthy();
		expect(
			container.querySelector('[data-space-desktop-section="desk-3"]'),
		).toBeTruthy();
		const unopened = screen.getByRole("region", {
			name: t("spaces.pane.unopenedAgents"),
		});
		// A rule, not a gap: above are sessions that are open and below are
		// agents that are not, and a rule is what marks a change of kind
		// (owner rule 2026-09-08). Still conditional on something being above,
		// which is what this case has.
		expect(
			unopened.firstElementChild?.querySelector(".bg-glass-hairline"),
		).toBeTruthy();
	});

	it("keeps a registered repository listed when nothing is open in it", () => {
		seedStore();
		useStore.setState({ projects: [...PROJECTS, REPO_THREE] });
		const { container } = render(<SpacesPane />);

		// Empty repositories trail the ones with rows (owner request 2026-09-03:
		// a repository with no agent or pane is still where you start one).
		expect(
			[...container.querySelectorAll("h3")].map((node) => node.textContent),
		).toEqual(["Repo One", "Repo Two", "Repo Three", t("spaces.pane.unopenedAgents")]);
		expect(
			within(screen.getByRole("region", { name: "Repo Three" })).getByText(
				t("spaces.repository.noSessions"),
			),
		).toBeTruthy();
	});

	it("keeps empty Space-view repositories unique across pins, open panes and filters", () => {
		seedStore();
		setGroupBy("space");
		useStore.setState((state) => ({
			projects: [...PROJECTS, REPO_THREE],
			agents: state.agents.slice(0, 2),
			pinnedPanes: { [panePinKey("desk-1", "agent:agent-a")]: true },
		}));
		const { container } = render(<SpacesPane />);
		expect(screen.queryByRole("region", { name: "Repo One" })).toBeNull();
		expect(screen.getAllByRole("region", { name: "Repo Two" })).toHaveLength(1);
		expect(screen.getAllByRole("region", { name: "Repo Three" })).toHaveLength(1);

		act(() => useStore.setState({ pinnedProjects: ["p3"] }));
		expect(screen.getAllByRole("region", { name: "Repo Three" })).toHaveLength(1);
		expect(screen.getByRole("region", { name: "Repo Three" }).closest("[data-spaces-pinned]")).toBeTruthy();
		act(() => useStore.setState({ pinnedProjects: [] }));
		expect(screen.getAllByRole("region", { name: "Repo Three" })).toHaveLength(1);

		act(() => useSpacesPaneUi.getState().setQuery("Repo Three"));
		expect(screen.queryByRole("region", { name: "Repo Three" })).toBeNull();
		act(() => useSpacesPaneUi.getState().setQuery(""));
		act(() => useStore.getState().setUiPrefs({ spacesViewOptions: {
			...useStore.getState().uiPrefs.spacesViewOptions,
			filters: { ...DEFAULT_SPACES_VIEW_OPTIONS.filters, status: ["working"] },
		} }));
		expect(screen.queryByRole("region", { name: "Repo Three" })).toBeNull();
		act(() => useStore.getState().setUiPrefs({ spacesViewOptions: {
			...DEFAULT_SPACES_VIEW_OPTIONS, groupBy: "space",
		} }));
		expect(screen.getByRole("region", { name: "Repo Three" })).toBeTruthy();

		act(() => useStore.setState((state) => ({
			agents: [...state.agents, makeAgent("agent-c", "p3", "New session")],
			layouts: { ...state.layouts, "desk-3": { panels: { "agent:agent-c": agentPane("agent-c") } } },
		})));
		expect(screen.getAllByRole("region", { name: "Repo Three" })).toHaveLength(1);
		const desktop = container.querySelector('[data-space-desktop-section="desk-3"]');
		expect(desktop?.contains(screen.getByRole("region", { name: "Repo Three" }))).toBe(true);
	});

	it("shows an empty repository message only while its folder is open", () => {
		seedStore();
		useStore.setState({ projects: [...PROJECTS, REPO_THREE] });
		render(<SpacesPane />);

		const repository = screen.getByRole("region", { name: "Repo Three" });
		const toggle = within(repository).getByRole("button", {
			name: "Repo Three",
		});
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(
			within(repository).getByText(t("spaces.repository.noSessions")),
		).toBeTruthy();

		fireEvent.click(toggle);

		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(
			within(repository).queryByText(t("spaces.repository.noSessions")),
		).toBeNull();
	});

	it("offers the quick-add rail on a repository nothing is open in", () => {
		seedStore();
		useStore.setState({ projects: [...PROJECTS, REPO_THREE] });
		render(<SpacesPane />);

		// The point of listing it (owner request 2026-09-03): a terminal or an
		// agent can start there. The rail's target is the registered project,
		// not an open pane's folder — there is none.
		expect(
			within(screen.getByRole("region", { name: "Repo Three" })).getByRole(
				"button",
				{ name: t("common.openTerminal") },
			),
		).toBeTruthy();
	});

	it.each(["repository", "space", "location", "environment", "updated", "status"] as const)(
		"moves pinned panes out of %s groups and restores them when unpinned",
		(groupBy) => {
			seedStore();
			setGroupBy(groupBy);
			const { container } = render(<SpacesPane />);
			const pinKey = panePinKey("desk-1", "agent:agent-a");
			fireEvent.contextMenu(container.querySelector('[data-space-key="agent:agent-a"]') as Element);
			fireEvent.click(screen.getByRole("menuitem", { name: t("workspace.paneMenu.pin") }));
			expect(useStore.getState().pinnedPanes[pinKey]).toBe(true);
			const row = container.querySelector('[data-space-key="agent:agent-a"]');
			expect(row?.closest("[data-spaces-pinned]")).toBeTruthy();
			expect(screen.getAllByText("Alpha Open")).toHaveLength(1);
			fireEvent.contextMenu(row as Element);
			fireEvent.click(screen.getByRole("menuitem", { name: t("workspace.paneMenu.unpin") }));
			expect(useStore.getState().pinnedPanes[pinKey]).toBeUndefined();
			const restored = container.querySelector('[data-space-key="agent:agent-a"]');
			expect(restored?.closest("[data-spaces-list]")).toBeTruthy();
			expect(restored?.closest("[data-spaces-pinned]")).toBeNull();
		},
	);

	it("gathers pinned repositories in a band at the top of the list, first but not fixed", () => {
		seedStore();
		useStore.setState({
			projects: [...PROJECTS, REPO_THREE],
			pinnedProjects: ["p3", "p2"],
			pinnedPanes: { [panePinKey("desk-2", "agent:agent-b")]: true },
		});
		const { container } = render(<SpacesPane />);

		const band = container.querySelector("[data-spaces-pinned]") as HTMLElement;
		expect(band).toBeTruthy();
		// The band leads the list, inside its scroller — first, not fixed. It
		// used to sit above the body in a scroll region of its own.
		expect(band.closest("[data-spaces-list]")).toBeTruthy();
		expect(band.previousElementSibling).toBeNull();
		expect(within(band).getByText(t("spaces.pane.pinned"))).toBeTruthy();
		expect(
			[...band.querySelectorAll("h3")].map((node) => node.textContent),
		).toEqual(["Repo Three", "Repo Two"]);
		expect(within(band).getByText("Bravo Open")).toBeTruthy();
		expect(
			within(band).getByText("Bravo Open").closest("[data-spaces-pinned-panes]"),
		).toBeTruthy();
		expect(screen.getAllByText("Bravo Open")).toHaveLength(1);
		const body = container.querySelector("[data-spaces-list]") as HTMLElement;
		// Everything after the band: the unpinned repository, then the queue.
		expect(
			[...body.querySelectorAll("h3")]
				.filter((node) => !band.contains(node))
				.map((node) => node.textContent),
		).toEqual(["Repo One", t("spaces.pane.unopenedAgents")]);
	});

	it("leaves the space off a row under its space heading and keeps it on a pinned row", () => {
		seedStore();
		useStore.setState((state) => ({
			pinnedPanes: { [panePinKey("desk-1", "agent:agent-a")]: true },
			uiPrefs: {
				...state.uiPrefs,
				spacesViewOptions: {
					...state.uiPrefs.spacesViewOptions,
					visibleFields: [],
				},
			},
		}));
		const { container } = render(<SpacesPane />);

		// The pinned list is flat: nothing over the row says which space it
		// is in, so the row does.
		const pinned = container.querySelector(
			'[data-space-key="agent:agent-a"]',
		) as HTMLElement;
		expect(pinned.closest("[data-spaces-pinned]")).toBeTruthy();
		expect(within(pinned).getByText("One")).toBeTruthy();
		// In the repository tree the row sits under its space heading already
		// (Repo Two › Two); repeating "Two" on the row said it twice.
		const repoTwo = screen.getByRole("region", { name: "Repo Two" });
		expect(
			within(repoTwo).getByRole("heading", { level: 4, name: "Two" }),
		).toBeTruthy();
		const listed = container.querySelector(
			'[data-space-key="agent:agent-b"]',
		) as HTMLElement;
		expect(repoTwo.contains(listed)).toBe(true);
		expect(within(listed).queryByText("Two")).toBeNull();
	});

	it("Show › Space off folds a repository's space tier away and hides the space on its rows", () => {
		seedStore();
		useStore.setState((state) => ({
			pinnedPanes: { [panePinKey("desk-1", "agent:agent-a")]: true },
			uiPrefs: {
				...state.uiPrefs,
				spacesViewOptions: {
					...state.uiPrefs.spacesViewOptions,
					showSpaces: false,
				},
			},
		}));
		const { container } = render(<SpacesPane />);

		// No space heading under the repository, and the row does not say it
		// either — the dimension is hidden, in the pinned band too.
		const repoTwo = screen.getByRole("region", { name: "Repo Two" });
		expect(within(repoTwo).queryByRole("heading", { level: 4 })).toBeNull();
		const listed = container.querySelector(
			'[data-space-key="agent:agent-b"]',
		) as HTMLElement;
		expect(repoTwo.contains(listed)).toBe(true);
		expect(within(listed).queryByText("Two")).toBeNull();
		const pinned = container.querySelector(
			'[data-space-key="agent:agent-a"]',
		) as HTMLElement;
		expect(within(pinned).queryByText("One")).toBeNull();
	});

	it("comes back where it was scrolled when the tab returns, as the Files tree does", () => {
		seedStore();
		const first = render(<SpacesPane />);
		const viewport = first.container.querySelector(
			'[data-slot="scroll-area-viewport"]',
		) as HTMLElement;
		viewport.scrollTop = 120;
		fireEvent.scroll(viewport);
		first.unmount();

		const second = render(<SpacesPane />);
		const restored = second.container.querySelector(
			'[data-slot="scroll-area-viewport"]',
		) as HTMLElement;
		expect(restored.scrollTop).toBe(120);
	});

	it("does not repeat pinned attention on a Space heading", () => {
		seedStore();
		useStore.setState({ pinnedProjects: ["p2"] });
		useAgentAttention.setState({
			displayStates: { "agent-a": "waiting", "agent-b": "blocked" },
		});
		setGroupBy("space");
		const { container } = render(<SpacesPane />);

		const band = container.querySelector("[data-spaces-pinned]");
		const bodySpace = container.querySelector(
			'[data-spaces-list] [data-space-desktop-section="desk-2"]',
		);
		if (!(band instanceof HTMLElement) || !(bodySpace instanceof HTMLElement)) {
			throw new Error("pinned attention fixture did not render");
		}
		expect(
			within(band).getByLabelText(t("spaces.group.attentionCount", { n: 1 })),
		).toBeTruthy();
		expect(
			within(bodySpace).queryByLabelText(
				t("spaces.group.attentionCount", { n: 1 }),
			),
		).toBeNull();
	});

	it("keeps pinned repositories in the band under a search, with rows filtered", () => {
		seedStore();
		useStore.setState({
			projects: [...PROJECTS, REPO_THREE],
			pinnedProjects: ["p3", "p2"],
		});
		const { container } = render(<SpacesPane />);
		act(() => {
			useSpacesPaneUi.getState().setQuery("Alpha");
		});

		const band = container.querySelector("[data-spaces-pinned]") as HTMLElement;
		expect(
			[...band.querySelectorAll("h3")].map((node) => node.textContent),
		).toEqual(["Repo Three", "Repo Two"]);
		expect(within(band).queryByText("Bravo Open")).toBeNull();
		expect(within(band).getAllByText(t("spaces.empty.noMatches"))).toHaveLength(2);
		expect(screen.getByText("Alpha Open")).toBeTruthy();
	});

	it("does not show an empty result beside a pinned search match", () => {
		seedStore();
		useStore.setState({ pinnedPanes: { [panePinKey("desk-2", "agent:agent-b")]: true } });
		setGroupBy("status");
		render(<SpacesPane />);

		act(() => {
			useSpacesPaneUi.getState().setQuery("Bravo Open");
		});

		const band = document.querySelector("[data-spaces-pinned]");
		if (!(band instanceof HTMLElement))
			throw new Error("pinned band did not render");
		expect(within(band).getByText("Bravo Open")).toBeTruthy();
		expect(screen.queryByRole("status")).toBeNull();
		act(() => useSpacesPaneUi.getState().setQuery("Alpha"));
		expect(screen.queryByText("Bravo Open")).toBeNull();
		expect(document.querySelector("[data-spaces-pinned]")).toBeNull();
	});

	it("draws no band without pins", () => {
		seedStore();
		render(<SpacesPane />);
		expect(document.querySelector("[data-spaces-pinned]")).toBeNull();
	});

	it("hides empty repositories under a search", () => {
		seedStore();
		useStore.setState({ projects: [...PROJECTS, REPO_THREE] });
		render(<SpacesPane />);

		act(() => {
			useSpacesPaneUi.getState().setQuery("Bravo");
		});

		expect(screen.queryByRole("region", { name: "Repo Three" })).toBeNull();
		expect(screen.getByText("Bravo Open")).toBeTruthy();
	});

	it("filters repositories by the search and hides the ones left empty", () => {
		seedStore();
		render(<SpacesPane />);

		const search = screen.getByRole("textbox", {
			name: t("spaces.pane.searchPlaceholder"),
		});
		search.focus();
		fireEvent.change(search, { target: { value: "Bravo" } });
		expect(useSpacesPaneUi.getState().query).toBe("Bravo");

		expect(screen.queryByRole("region", { name: "Repo One" })).toBeNull();
		expect(screen.getByText("Bravo Open")).toBeTruthy();
		expect(screen.queryByText("Alpha Open")).toBeNull();

		fireEvent.keyDown(search, { key: "Escape" });
		expect(useSpacesPaneUi.getState().query).toBe("");
		expect(screen.getByRole("region", { name: "Repo One" })).toBeTruthy();
		expect(screen.getByText("Alpha Open")).toBeTruthy();
		expect(document.activeElement).toBe(search);
	});
});

describe("SpacesPane derivation cost", () => {
	it("ignores activity and attention publications outside every displayed agent", async () => {
		seedStore();
		const onRender = vi.fn();
		render(
			<Profiler id="spaces" onRender={onRender}>
				<SpacesPane />
			</Profiler>,
		);
		await act(async () => {
			await Promise.resolve();
		});
		const commits = onRender.mock.calls.length;
		const lookups = conversationLookupCalls();
		for (let index = 0; index < 32; index += 1) {
			act(() =>
				useStore
					.getState()
					.setAgentActivity(
						"not-registered",
						index % 2 ? "working" : "waiting",
					),
			);
			act(() =>
				useAgentAttention.getState().applyAttentionResolution({
					displayStates: {
						...useAgentAttention.getState().displayStates,
						"not-registered": index % 2 ? "blocked" : "waiting",
					},
					bumps: [{ agentId: "not-registered", kind: "approval" }],
					consumedArms: [],
				}),
			);
			act(() => useAgentAttention.getState().ack("not-registered"));
		}
		expect.soft(onRender.mock.calls.length - commits).toBe(0);
		expect(conversationLookupCalls() - lookups).toBe(0);
		expect(screen.getByText("U Alpha")).toBeTruthy();
		expect(screen.getByText("Alpha Open")).toBeTruthy();
	});

	it("keeps unopened activity, unread ordering, acknowledgement and hidden episode recovery current", () => {
		seedStore();
		const { container } = render(<SpacesPane />);
		const ids = () =>
			[...container.querySelectorAll('[data-space-kind="unopened-agent"]')].map(
				(row) => row.getAttribute("data-agent-id"),
			);
		const row = () =>
			container.querySelector('[data-agent-id="agent-u2"]') as HTMLElement;
		act(() => useStore.getState().setAgentActivity("agent-u2", "connecting"));
		expect(
			within(row()).getByRole("img", { name: activityLabel("connecting") }),
		).toBeTruthy();
		const bump = () =>
			useAgentAttention.getState().applyAttentionResolution({
				displayStates: { "agent-u1": "blocked", "agent-u2": "blocked" },
				bumps: [{ agentId: "agent-u2", kind: "done" }],
				consumedArms: [],
			});
		act(bump);
		expect(ids().slice(0, 2)).toEqual(["agent-u2", "agent-u1"]);
		expect(
			within(row()).getByRole("img", { name: activityLabel("blocked") }),
		).toBeTruthy();
		act(() => useAgentAttention.getState().ack("agent-u2"));
		expect(ids().slice(0, 2)).toEqual(["agent-u1", "agent-u2"]);
		act(() =>
			useUnopenedAgentVisibilityStore
				.getState()
				.hide({ id: "agent-u2", episode: 1 }),
		);
		expect(row()).toBeNull();
		act(() => useAgentAttention.getState().ack("agent-u2"));
		expect(row()).toBeNull();
		act(bump);
		expect(ids().slice(0, 2)).toEqual(["agent-u2", "agent-u1"]);
		act(() =>
			useAgentAttention.setState({ displayStates: {}, episodes: {}, acks: {} }),
		);
		act(() => useUnopenedAgentVisibilityStore.getState().restoreAll());
		expect(
			within(row()).getByRole("img", { name: activityLabel("connecting") }),
		).toBeTruthy();
	});

	it("resubscribes when unopened candidates are added, opened, hidden, restored or removed", async () => {
		seedStore();
		const onRender = vi.fn();
		const { container } = render(
			<Profiler id="spaces" onRender={onRender}>
				<SpacesPane />
			</Profiler>,
		);
		await act(async () => {
			await Promise.resolve();
		});
		const row = () =>
			container.querySelector(
				'[data-space-kind="unopened-agent"][data-agent-id="agent-new"]',
			);
		act(() => useStore.getState().setAgentActivity("agent-new", "connecting"));
		act(() =>
			useStore.setState((state) => ({
				agents: [...state.agents, makeAgent("agent-new", "p1", "New Agent")],
			})),
		);
		expect(
			within(row() as HTMLElement).getByRole("img", {
				name: activityLabel("connecting"),
			}),
		).toBeTruthy();
		act(() =>
			useStore.setState((state) => ({
				layouts: {
					...state.layouts,
					"desk-3": { panels: { "agent:agent-new": agentPane("agent-new") } },
				},
			})),
		);
		expect(row()).toBeNull();
		act(() => useStore.getState().setAgentActivity("agent-new", "exited"));
		act(() =>
			useStore.setState((state) => ({
				layouts: { ...state.layouts, "desk-3": { panels: {} } },
			})),
		);
		expect(
			within(row() as HTMLElement).getByRole("img", {
				name: activityLabel("exited"),
			}),
		).toBeTruthy();
		act(() => useHiddenPanes.getState().markHidden("agent-new", "desk-3", "agent:agent-new"));
		expect(row()).toBeNull();
		act(() => useStore.getState().setAgentActivity("agent-new", "connecting"));
		act(() => useHiddenPanes.getState().clearHidden("agent-new"));
		expect(
			within(row() as HTMLElement).getByRole("img", {
				name: activityLabel("connecting"),
			}),
		).toBeTruthy();
		act(() =>
			useStore.setState((state) => ({
				agents: state.agents.filter((agent) => agent.id !== "agent-new"),
			})),
		);
		expect(row()).toBeNull();
		const commits = onRender.mock.calls.length;
		const lookups = conversationLookupCalls();
		act(() => useStore.getState().setAgentActivity("agent-new", "exited"));
		act(() =>
			useAgentAttention
				.getState()
				.applyAttentionResolution({
					displayStates: { "agent-new": "blocked" },
					bumps: [],
					consumedArms: [],
				}),
		);
		expect.soft(onRender.mock.calls.length - commits).toBe(0);
		expect(conversationLookupCalls() - lookups).toBe(0);
	});

	it("looks up provider history only for unopened rows after an agent edit", () => {
		seedStore();
		render(<SpacesPane />);
		const baseline = conversationLookupCalls();

		act(() => {
			useStore.setState((state) => ({
				agents: state.agents.map((agent) =>
					agent.id === "agent-a"
						? { ...agent, displayName: "Renamed Open" }
						: agent,
				),
			}));
		});

		expect(screen.getByText("Renamed Open")).toBeTruthy();
		expect(conversationLookupCalls() - baseline).toBe(3);
	});

	it("does not re-render repository groups for an unrelated pane re-render", () => {
		seedStore();
		render(<SpacesPane />);
		const baseline = remoteHostIdCalls();

		act(() => {
			useStore.setState({ detected: { p1: [] } });
		});

		expect(remoteHostIdCalls() - baseline).toBe(0);
	});

	it("re-renders only the changed row's group when one row updates", () => {
		seedStore();
		render(<SpacesPane />);
		const baseline = remoteHostIdCalls();

		act(() => {
			useStore.setState((state) => ({
				sessionActivity: {
					...state.sessionActivity,
					"session-agent-a": { text: "new prompt", at: Date.now() },
				},
			}));
		});

		// Exactly the group owning agent-a re-renders; the other group bails.
		expect(remoteHostIdCalls() - baseline).toBe(1);
	});

	it("derives the unopened list with one conversation lookup per attention event", () => {
		seedStore();
		render(<SpacesPane />);
		const baseline = conversationLookupCalls();

		act(() => {
			useAgentAttention.setState((state) => ({
				acks: { ...state.acks, "agent-u1": 0 },
			}));
		});

		// The provider inventory is indexed once, then each unopened candidate
		// performs one O(1) exact-identity lookup before sorting.
		expect(conversationLookupCalls() - baseline).toBe(3);
	});
});

describe("SpacesPane selection", () => {
	/** A third repository after Repo Two, so a range can span a fold. */
	function seedThirdRepository() {
		useStore.setState((state) => ({
			projects: [
				...state.projects,
				{
					id: "p3",
					name: "Repo Three",
					path: "/repo-three",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [
				...state.agents,
				{
					...makeAgent("agent-c", "p3", "Charlie Open"),
					worktreePath: "/repo-three/wt-agent-c",
				},
			],
			layouts: {
				...state.layouts,
				"desk-2": {
					panels: {
						"agent:agent-b": agentPane("agent-b"),
						"agent:agent-c": agentPane("agent-c"),
					},
				},
			},
		}));
	}
	/** The row's main button — the click target that selects and navigates. */
	const row = (container: HTMLElement, key: string) => {
		const node = container.querySelector<HTMLElement>(
			`[data-space-key="${key}"] button`,
		);
		if (!node) throw new Error(`row ${key} did not render`);
		return node;
	};
	const selectedKeys = (container: HTMLElement) =>
		[...container.querySelectorAll("[data-space-selected]")].map((node) =>
			node.getAttribute("data-space-key"),
		);
	/** The repository's fold toggle — the button named by the repository. */
	const foldToggle = (name: string) =>
		within(screen.getByRole("region", { name })).getByRole("button", { name });

	it("shift-selects in pinned-first order and drops a pin excluded by filters", () => {
		seedStore();
		seedThirdRepository();
		useStore.setState({ pinnedPanes: { [panePinKey("desk-2", "agent:agent-c")]: true } });
		useAgentAttention.setState({ displayStates: {
			"agent-a": "blocked", "agent-b": "blocked", "agent-c": "working",
		} });
		const { container } = render(<SpacesPane />);
		fireEvent.click(row(container, "agent:agent-c"));
		fireEvent.click(row(container, "agent:agent-b"), { shiftKey: true });
		expect(selectedKeys(container)).toEqual(["agent:agent-c", "agent:agent-a", "agent:agent-b"]);
		act(() => useStore.setState((state) => ({ uiPrefs: {
			...state.uiPrefs, spacesViewOptions: {
				...state.uiPrefs.spacesViewOptions,
				filters: { ...state.uiPrefs.spacesViewOptions.filters, status: ["blocked"] },
			},
		} })));
		expect(screen.queryByText("Charlie Open")).toBeNull();
		expect(selectedKeys(container)).toEqual(["agent:agent-a", "agent:agent-b"]);
	});

	it("shift-selects across a folded repository without taking its hidden rows", () => {
		seedStore();
		seedThirdRepository();
		useSpacesCollapsedGroups.setState({ collapsed: { '["project","p2"]': true } });
		const { container } = render(<SpacesPane />);

		fireEvent.click(row(container, "agent:agent-a"));
		fireEvent.click(row(container, "agent:agent-c"), { shiftKey: true });

		expect(selectedKeys(container)).toEqual(["agent:agent-a", "agent:agent-c"]);
		// Unfolding shows the row that was behind the fold was never selected —
		// bulk actions act on what the user could see.
		fireEvent.click(foldToggle("Repo Two"));
		expect(selectedKeys(container)).toEqual(["agent:agent-a", "agent:agent-c"]);
	});

	it("drops rows that fold away from the selection", () => {
		seedStore();
		const { container } = render(<SpacesPane />);
		fireEvent.click(row(container, "agent:agent-a"), { metaKey: true });
		expect(selectedKeys(container)).toEqual(["agent:agent-a"]);

		fireEvent.click(foldToggle("Repo One"));
		fireEvent.click(foldToggle("Repo One"));

		expect(selectedKeys(container)).toEqual([]);
	});
});

describe("SpacesPane row detail", () => {
	it("shows where the folder is for a pane at the repository root", () => {
		seedStore();
		// An agent working in the repository root rather than a worktree.
		useStore.setState((state) => ({
			agents: [
				...state.agents,
				{ ...makeAgent("agent-root", "p1", "Root Open"), worktreePath: "/repo-one" },
			],
			layouts: {
				...state.layouts,
				"desk-1": {
					panels: {
						"agent:agent-a": agentPane("agent-a"),
						"agent:agent-root": agentPane("agent-root"),
					},
				},
			},
		}));
		const { container } = render(<SpacesPane />);

		const rootRow = container.querySelector('[data-space-key="agent:agent-root"]');
		if (!rootRow) throw new Error("row did not render");
		// The heading says "Repo One"; the root row's info line says where that
		// folder is, then the branch. A row's Details is never empty (owner call
		// 2026-09-14, over the 2026-09-03 blank root).
		expect(rootRow.textContent).toContain("/repo-one");
		expect(rootRow.textContent).toContain("agent/agent-root");
	});
});

describe("SpacesPane unopened agents by repository", () => {
	const unopenedRegion = (name: string) =>
		screen.getByRole("region", {
			name: `${t("spaces.pane.unopenedAgents")} ${name}`,
		});

  it("clears all unopened agents including hidden/search-filtered rows, preserves worktrees, and prevents duplicate dispatch", async () => {
    seedStore();
    useUnopenedAgentVisibilityStore.getState().hide({ id: "agent-u2", episode: 0 });
    useSpacesPaneUi.setState({ query: "U Alpha" });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    vi.mocked(prepareAgentRemoval).mockImplementation(async (id) => ({
      preview: { agents: [useStore.getState().agents.find((agent) => agent.id === id)!] },
    }));
    vi.mocked(executeAgentRemoval).mockImplementation(async () => {
      await pending;
      return { agentIds: [] };
    });
    render(<SpacesPane />);
    const clear = screen.getByRole("button", { name: t("spaces.pane.clearUnopened") });
    fireEvent.click(clear);
    fireEvent.click(clear);
    await waitFor(() => expect(executeAgentRemoval).toHaveBeenCalledTimes(3));
    expect(vi.mocked(prepareAgentRemoval).mock.calls).toEqual(
      useStore.getState().agents.filter((agent) => agent.id.startsWith("agent-u")).map((agent) => [
        agent.id, { deleteWorktree: false, expectedIdentity: agentRemovalRegistrationIdentity(agent) },
      ]),
    );
    expect((clear as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    expect((clear as HTMLButtonElement).disabled).toBe(false);
  });

  it("skips an agent whose pane opens while removal is being prepared", async () => {
    seedStore();
    const element = document.createElement("div");
    document.body.append(element);
    const api = createDockview(element, {
      createComponent: () => ({ element: document.createElement("div"), init() {} }),
    });
    vi.mocked(prepareAgentRemoval).mockImplementation(async (id) => {
      if (id === "agent-u1") {
        api.addPanel({ id: "new-slot", component: "agent", params: { agentRef: { agentId: id } } });
        registerDockview("clear-test", api);
      }
      return { preview: { agents: [useStore.getState().agents.find((agent) => agent.id === id)!] } };
    });
    vi.mocked(executeAgentRemoval).mockResolvedValue({ agentIds: [] });
    try {
      render(<SpacesPane />);
      fireEvent.click(screen.getByRole("button", { name: t("spaces.pane.clearUnopened") }));
      await waitFor(() => expect(executeAgentRemoval).toHaveBeenCalledTimes(2));
      expect(vi.mocked(executeAgentRemoval).mock.calls.map(([operation]) => operation.preview.agents[0].id))
        .toEqual(["agent-u2", "agent-u3"]);
    } finally {
      unregisterDockview("clear-test", api);
      api.dispose();
      element.remove();
    }
  });

  it("reports a failed removal and still clears the other unopened agents", async () => {
    seedStore();
    vi.mocked(prepareAgentRemoval).mockImplementation(async (id) => {
      if (id === "agent-u2") throw new Error("Host unreachable");
      return { preview: { agents: [useStore.getState().agents.find((agent) => agent.id === id)!] } };
    });
    vi.mocked(executeAgentRemoval).mockImplementation(async (operation) => {
      const ids = operation.preview.agents.map((agent) => agent.id);
      useStore.setState((state) => ({ agents: state.agents.filter((agent) => !ids.includes(agent.id)) }));
      return { agentIds: ids };
    });
    render(<SpacesPane />);
    fireEvent.click(screen.getByRole("button", { name: t("spaces.pane.clearUnopened") }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("U Bravo: Host unreachable"));
    expect(useStore.getState().agents.map((agent) => agent.id)).toEqual(["agent-a", "agent-b", "agent-u2"]);
    expect(executeAgentRemoval).toHaveBeenCalledTimes(2);
  });

	it("groups the unopened agents under their repositories and folds a group on its own", () => {
		seedStore();
		render(<SpacesPane />);

		const repoOne = unopenedRegion("Repo One");
		expect(within(repoOne).getByText("U Alpha")).toBeTruthy();
		expect(within(repoOne).getByText("U Bravo")).toBeTruthy();
		expect(within(unopenedRegion("Repo Two")).getByText("U Charlie")).toBeTruthy();
		// The queue only names the repository: no quick-add rail on its head row
		// (the open list's head row keeps it).
		expect(
			within(repoOne).queryByRole("button", { name: t("common.openTerminal") }),
		).toBeNull();
		expect(
			within(screen.getByRole("region", { name: "Repo One" })).getByRole(
				"button",
				{ name: t("common.openTerminal") },
			),
		).toBeTruthy();

		fireEvent.click(within(repoOne).getByRole("button", { name: "Repo One" }));

		expect(within(repoOne).queryByText("U Alpha")).toBeNull();
		// The open list's Repo One is a different fold: it stays open.
		expect(screen.getByText("Alpha Open")).toBeTruthy();
		expect(useSpacesCollapsedGroups.getState().collapsed).toEqual({
			[`unopened ${REPO_ONE_KEY}`]: true,
		});
	});

	it("starts folded — the queue is closed until someone opens it", () => {
		seedStore();
		// The store's own initial state, not the test reset's open map.
		useSpacesCollapsedGroups.setState(useSpacesCollapsedGroups.getInitialState());
		render(<SpacesPane />);
		const section = screen.getByRole("region", {
			name: t("spaces.pane.unopenedAgents"),
		});

		expect(
			within(section)
				.getByRole("button", { name: new RegExp(t("spaces.pane.unopenedAgents")) })
				.getAttribute("aria-expanded"),
		).toBe("false");
		expect(within(section).queryByText("U Alpha")).toBeNull();
		// The open list is not folded by default.
		expect(screen.getByText("Alpha Open")).toBeTruthy();
	});

	it("folds the whole section from its heading and remembers it", () => {
		seedStore();
		render(<SpacesPane />);
		const section = screen.getByRole("region", {
			name: t("spaces.pane.unopenedAgents"),
		});
		const toggle = within(section).getByRole("button", {
			name: new RegExp(t("spaces.pane.unopenedAgents")),
		});
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		// The label leads, in the column the other headings use; the chevron
		// trails at the far end of the row.
		expect(toggle.firstElementChild?.tagName).toBe("H3");
		expect(toggle.lastElementChild?.tagName.toLowerCase()).toBe("svg");

		fireEvent.click(toggle);

		expect(within(section).queryByText("U Alpha")).toBeNull();
		expect(within(section).queryByText("U Charlie")).toBeNull();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(useSpacesCollapsedGroups.getState().collapsed).toEqual({ unopened: true });
		// The open list is untouched.
		expect(screen.getByText("Alpha Open")).toBeTruthy();
	});
});

describe("SpacesPane focused pane under a fold", () => {
	const focusPane = (key: string) =>
		act(() => {
			useStore.setState({
				focusCtx: { key, cwd: "/repo-one", source: "local", label: "one" },
			});
		});
	/** A second Repo One pane, so the fold has something to keep hidden. */
	const seedSecondRepoOnePane = () =>
		useStore.setState((state) => ({
			agents: [...state.agents, makeAgent("agent-a2", "p1", "Alpha Two")],
			layouts: {
				...state.layouts,
				"desk-1": {
					panels: {
						"agent:agent-a": agentPane("agent-a"),
						"agent:agent-a2": agentPane("agent-a2"),
					},
				},
			},
		}));

	it("shows only the focused pane's row under a folded repository, without unfolding it", () => {
		seedStore();
		seedSecondRepoOnePane();
		useSpacesCollapsedGroups.setState({ collapsed: { [REPO_ONE_KEY]: true } });
		// jsdom has no scrollIntoView; the row must still ask for it.
		const scrollIntoView = vi.fn();
		Object.defineProperty(Element.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
		try {
			const { container } = render(<SpacesPane />);
			expect(screen.queryByText("Alpha Open")).toBeNull();

			focusPane("agent:agent-a");

			const repoOne = screen.getByRole("region", { name: "Repo One" });
			expect(within(repoOne).getByText("Alpha Open")).toBeTruthy();
			expect(within(repoOne).queryByText("Alpha Two")).toBeNull();
			// The fold itself is untouched; the count says what is still behind it.
			expect(useSpacesCollapsedGroups.getState().collapsed).toEqual({
				[REPO_ONE_KEY]: true,
			});
			expect(
				within(repoOne).getByRole("button", { name: "Repo One" }).getAttribute("aria-expanded"),
			).toBe("false");
			expect(
				container
					.querySelector('[data-space-key="agent:agent-a"]')
					?.getAttribute("data-pane-focused"),
			).toBe("");
			expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

			// Focus moving elsewhere folds the row away again.
			focusPane("agent:agent-b");
			expect(within(repoOne).queryByText("Alpha Open")).toBeNull();
		} finally {
			Reflect.deleteProperty(Element.prototype, "scrollIntoView");
		}
	});

	it("keeps the focused row selectable across a fold", () => {
		seedStore();
		seedSecondRepoOnePane();
		useSpacesCollapsedGroups.setState({ collapsed: { [REPO_ONE_KEY]: true } });
		render(<SpacesPane />);
		focusPane("agent:agent-a");

		const row = document.querySelector<HTMLElement>(
			'[data-space-key="agent:agent-a"] button',
		);
		if (!row) throw new Error("focused row did not render");
		fireEvent.click(row, { metaKey: true });

		expect(row.closest("[data-space-key]")?.hasAttribute("data-space-selected")).toBe(true);
	});

	it("keeps only the focused row visible under a folded status facet", () => {
		seedStore();
		seedSecondRepoOnePane();
		useAgentAttention.setState({
			displayStates: {
				"agent-a": "blocked",
				"agent-a2": "blocked",
				"agent-b": "working",
			},
		});
		setGroupBy("status");
		const facetKey = '["facet","status","blocked"]';
		useSpacesCollapsedGroups.setState({ collapsed: { [facetKey]: true } });
		const { container } = render(<SpacesPane />);

		focusPane("agent:agent-a");

		const facet = container.querySelector(
			'[data-spaces-facet-group="status:blocked"]',
		);
		if (!(facet instanceof HTMLElement))
			throw new Error("blocked facet did not render");
		expect(within(facet).getByText("Alpha Open")).toBeTruthy();
		expect(within(facet).queryByText("Alpha Two")).toBeNull();
		expect(useSpacesCollapsedGroups.getState().collapsed).toEqual({
			[facetKey]: true,
		});
		const row = facet.querySelector<HTMLElement>(
			'[data-space-key="agent:agent-a"] button',
		);
		if (!row) throw new Error("focused facet row did not render");
		fireEvent.click(row, { metaKey: true });
		expect(
			row.closest("[data-space-key]")?.hasAttribute("data-space-selected"),
		).toBe(true);

		const source = container.querySelector('[data-space-key="agent:agent-b"]');
		const target = facet.querySelector('[data-space-desktop-section="desk-1"]');
		if (!source || !target)
			throw new Error("focused facet drop target did not render");
		const dataTransfer = dragDataTransfer();
		fireEvent.dragStart(source, { dataTransfer });
		fireEvent.dragOver(target, { dataTransfer });
		expect(target.className).toContain("bg-accent/40");
	});

	it("offers expand when folded facets retain only the focused row", async () => {
		seedStore();
		useAgentAttention.setState({
			displayStates: { "agent-a": "blocked", "agent-b": "working" },
		});
		setGroupBy("status");
		useSpacesCollapsedGroups.setState({
			collapsed: {
				'["facet","status","blocked"]': true,
				'["facet","status","working"]': true,
				unopened: true,
			},
		});
		focusPane("agent:agent-a");
		render(<SpacesPane />);

		expect(screen.getByText("Alpha Open")).toBeTruthy();
		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);

		expect(
			screen.queryByRole("menuitem", { name: t("spaces.pane.collapseAll") }),
		).toBeNull();
		expect(
			await screen.findByRole("menuitem", {
				name: t("spaces.pane.expandAll"),
			}),
		).toBeTruthy();
	});
});

describe("SpacesPane pane movement", () => {
	it.each(["same desktop", "malformed payload", "empty payload"])(
		"does not move a row with %s",
		(reason) => {
			seedStore();
			const { container } = render(<SpacesPane />);
			const source = container.querySelector('[data-space-key="agent:agent-a"]');
			const target = container.querySelector(
				`[data-desktop-id="${reason === "same desktop" ? "desk-1" : "desk-2"}"]`,
			);
			if (!source || !target) throw new Error("pane drag fixture did not render");
			const dataTransfer = dragDataTransfer();
			fireEvent.dragStart(source, { dataTransfer });
			if (reason !== "same desktop") {
				dataTransfer.setData("text/plain", reason === "empty payload" ? "" : "dure:{");
			}
			fireEvent.drop(target, { dataTransfer });
			expect(movePanelsToDesktop).not.toHaveBeenCalled();
			expect(getDragState()).toBeNull();
		},
	);

	it("moves the payload once after window capture has cleared the drag identity", () => {
		seedStore();
		const { container } = render(<SpacesPane />);
		const source = container.querySelector('[data-space-key="agent:agent-a"]');
		const target = container.querySelector('[data-desktop-id="desk-2"]');
		if (!source || !target) throw new Error("pane drag fixture did not render");
		const dataTransfer = dragDataTransfer();
		window.addEventListener("drop", endSpacesRowDrag, true);
		try {
			fireEvent.dragStart(source, { dataTransfer });
			fireEvent.dragOver(target, { dataTransfer });
			fireEvent.drop(target, { dataTransfer });

			expect(movePanelsToDesktop).toHaveBeenCalledOnce();
			expect(movePanelsToDesktop).toHaveBeenCalledWith(
				[{ panelId: "agent:agent-a", fromDesktopId: "desk-1" }],
				"desk-2",
			);
			expect(getDragState()).toBeNull();
		} finally {
			window.removeEventListener("drop", endSpacesRowDrag, true);
			endSpacesRowDrag();
		}
	});

	it("highlights only one repeated desktop target across status facets", () => {
		seedStore();
		useStore.setState((state) => ({
			agents: [...state.agents, makeAgent("agent-b2", "p2", "Bravo Two")],
			layouts: {
				...state.layouts,
				"desk-2": {
					panels: {
						"agent:agent-b": agentPane("agent-b"),
						"agent:agent-b2": agentPane("agent-b2"),
					},
				},
			},
		}));
		useAgentAttention.setState({
			displayStates: {
				"agent-a": "waiting",
				"agent-b": "blocked",
				"agent-b2": "working",
			},
		});
		setGroupBy("status");
		const { container } = render(<SpacesPane />);
		const source = container.querySelector('[data-space-key="agent:agent-a"]');
		const targets = [
			...container.querySelectorAll('[data-space-desktop-section="desk-2"]'),
		];
		if (!source || targets.length !== 2) {
			throw new Error("repeated facet drop-target fixture did not render");
		}
		const blockedFacet = container.querySelector(
			'[data-spaces-facet-group="status:blocked"]',
		);
		const workingFacet = container.querySelector(
			'[data-spaces-facet-group="status:working"]',
		);
		if (
			!(blockedFacet instanceof HTMLElement) ||
			!(workingFacet instanceof HTMLElement)
		) {
			throw new Error("status facet landmarks did not render");
		}
		expect(
			within(blockedFacet).getByRole("region", {
				name: `${activityLabel("blocked")} Repo Two`,
			}),
		).toBeTruthy();
		expect(
			within(workingFacet).getByRole("region", {
				name: `${activityLabel("working")} Repo Two`,
			}),
		).toBeTruthy();
		const dataTransfer = dragDataTransfer();

		fireEvent.dragStart(source, { dataTransfer });
		fireEvent.dragOver(targets[0] as Element, { dataTransfer });

		expect(
			targets.filter((node) => node.className.includes("bg-accent/40")),
		).toEqual([targets[0]]);
		fireEvent.drop(targets[0] as Element, { dataTransfer });
		expect(movePanelsToDesktop).toHaveBeenCalledOnce();
		expect(movePanelsToDesktop).toHaveBeenCalledWith(
			[{ panelId: "agent:agent-a", fromDesktopId: "desk-1" }],
			"desk-2",
		);
	});

	it("moves a dragged pane tab once when it is dropped on a space heading", () => {
		seedStore();
		const { container } = render(<SpacesPane />);
		const target = container.querySelector('[data-desktop-id="desk-2"]');
		if (!target) throw new Error("space heading did not render");
		setDragState({ panelId: "agent:agent-a", fromDesktopId: "desk-1" });
		const dataTransfer = dragDataTransfer();

		fireEvent.dragOver(target, { dataTransfer });
		fireEvent.drop(target, { dataTransfer });

		// The heading sits inside its section; one drop is one move.
		expect(movePanelsToDesktop).toHaveBeenCalledOnce();
		expect(movePanelsToDesktop).toHaveBeenCalledWith(
			[{ panelId: "agent:agent-a", fromDesktopId: "desk-1" }],
			"desk-2",
		);
		// The drag is spent — the next native drag over a section is not a move.
		expect(getDragState()).toBeNull();
	});

	it("moves a dragged pane row to the space whose heading it is dropped on", () => {
		seedStore();
		const { container } = render(<SpacesPane />);
		const source = container.querySelector('[data-space-key="agent:agent-a"]');
		const target = container.querySelector('[data-desktop-id="desk-2"]');
		if (!source || !target) throw new Error("pane drag fixture did not render");
		const dataTransfer = dragDataTransfer();

		fireEvent.dragStart(source, { dataTransfer });
		fireEvent.dragOver(target, { dataTransfer });
		// Only the hovered section lights up — the same space may be listed
		// under several repositories.
		const highlighted = [
			...container.querySelectorAll("[data-space-desktop-section]"),
		].filter((node) => node.className.includes("bg-accent/40"));
		expect(highlighted.map((node) => node.getAttribute("data-space-desktop-section"))).toEqual([
			"desk-2",
		]);
		fireEvent.drop(target, { dataTransfer });

		expect(movePanelsToDesktop).toHaveBeenCalledOnce();
		expect(movePanelsToDesktop).toHaveBeenCalledWith(
			[{ panelId: "agent:agent-a", fromDesktopId: "desk-1" }],
			"desk-2",
		);
	});
});
