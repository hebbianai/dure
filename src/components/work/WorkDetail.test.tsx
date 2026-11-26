// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { t } from "@/lib/i18n";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { WORK_VIEW_DEFAULT } from "@/lib/work/workViewState";
import { useWorkViewStore } from "@/lib/work/workViewStore";
import { useStore } from "@/store";
import {
	agentFixture,
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Agent, Project, Space } from "@/types";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	chatSession: vi.fn(),
	terminal: vi.fn(),
	open: vi.fn(),
	revealAgent: vi.fn(),
}));
vi.mock("@/lib/ipc/conversations", () => ({
	readProviderConversationTranscript: (...args: unknown[]) =>
		mocks.read(...args),
	readAgentBackgroundWork: async () => ({
		items: [],
		counts: { subagents: 0, workflows: 0, shells: 0, monitors: 0 },
		truncated: false,
	}),
}));
vi.mock("@/components/agents/chat/useAgentChatSession", () => ({
	useAgentChatSession: (...args: unknown[]) => mocks.chatSession(...args),
}));
vi.mock("@/components/terminal/TerminalView", () => ({
	TerminalView: () => {
		mocks.terminal();
		return null;
	},
}));
vi.mock("@/components/agents/chat/ChatMarkdown", () => ({
	ChatMarkdown: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}));
vi.mock("@/lib/workspace/window/windows", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/window/windows")>()),
	openAgentSessionWindow: (...args: unknown[]) => mocks.open(...args),
}));
vi.mock("@/lib/agents/nextUpNavigation", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agents/nextUpNavigation")>()),
	revealAgent: mocks.revealAgent,
}));

import { WorkMain } from "@/components/work/WorkMain";

// app: a ── b ── c ── d (a chain four deep), and solo
// api: chatty, a Chat agent with no pane
function agent(id: string, patch: Partial<Agent> = {}, parentSession?: string) {
	return managedAgentFixture({
		id,
		name: id,
		displayName: `Agent ${id}`,
		provider: "codex",
		projectId: "p-app",
		sessionId: `s-${id}`,
		runtimeBinding: managedBindingFixture({ sessionId: `s-${id}` }),
		...(parentSession
			? { runParent: { sessionId: parentSession, workspaceId: "workspace-1" } }
			: {}),
		...patch,
	});
}

const conversationIdentity = {
	...stopFenceFixture({ terminalEpoch: "epoch-d" }),
	schemaVersion: 1 as const,
	sessionId: "s-d",
	workspaceId: "workspace-1",
	revision: "1",
	observedThroughOutputSeq: "1",
	source: "provider_event" as const,
	providerId: "codex" as const,
	conversationId: "conversation-d",
};

const chatty = agentFixture({
	id: "chatty",
	name: "chatty",
	displayName: "Agent chatty",
	projectId: "p-api",
	sessionId: "s-chatty",
	interactionProfile: {
		schemaVersion: 1,
		kind: "structured_protocol",
		backendProfileId: "local",
		interactionSessionId: "interaction-chatty",
	},
});

const agents: Agent[] = [
	agent("a"),
	agent("b", {}, "s-a"),
	agent("c", {}, "s-b"),
	agent(
		"d",
		{
			runtimeBinding: managedBindingFixture({
				sessionId: "s-d",
				conversationIdentity,
			}),
		},
		"s-c",
	),
	agent("solo"),
	chatty,
];

const transcript = {
	schemaVersion: 1,
	provider: "codex",
	conversationId: "conversation-d",
	historyComplete: true,
	finalResponse: "Fixed the flaky test",
	entries: [
		{ role: "user", text: "Fix the flaky test" },
		{ role: "agent", text: "Fixed the flaky test" },
	],
};

function column(key: string): HTMLElement {
	return document.querySelector<HTMLElement>(
		`[data-work-column="${key}"]`,
	) as HTMLElement;
}

function columnKeys(): string[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>("[data-work-column]"),
	).map((element) => element.dataset.workColumn as string);
}

beforeEach(() => {
	// jsdom has no layout; expose a visible viewport to the virtualizer.
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			return this.hasAttribute("data-index") ? 32 : 600;
		},
	);
	useStore.setState({
		agents,
		activeSpaceId: "space-a",
		spaces: [{ id: "space-a", name: "Main" }] as Space[],
		layouts: {},
		projects: [
			{ id: "p-app", name: "app", path: "/app", kind: "local", isRepo: true },
			{ id: "p-api", name: "api", path: "/api", kind: "local", isRepo: true },
		] as Project[],
		hmuxSessionMetadata: {},
		sessionActivity: {},
		sessionAgentRuntimeState: {
			"s-d": {
				terminalEpoch: "epoch-d",
				revision: "1",
				observedThroughOutputSeq: "1",
				source: "provider_event",
				lifecycle: "running",
				activity: "waiting",
				attention: "none",
				turnCompletedCount: "1",
			},
		},
	});
	useAgentAttention.setState({
		...useAgentAttention.getInitialState(),
		displayStates: { a: "working", b: "working", c: "working", d: "waiting" },
	});
	useWorkViewStore.setState(WORK_VIEW_DEFAULT);
	useWindowSidebarStore.getState().setTab("work");
	mocks.read.mockReset();
	mocks.read.mockResolvedValue(transcript);
	mocks.chatSession.mockReset();
	mocks.chatSession.mockReturnValue({
		phase: "connecting",
		reconnecting: false,
		loadingOlder: false,
		readProviderHistory: async () => null,
		loadOlder: async () => {},
		retryConnection: () => {},
	});
	mocks.terminal.mockReset();
	mocks.open.mockReset();
	mocks.revealAgent.mockReset();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	useWindowSidebarStore.getState().setTab("spaces");
});

describe("Work detail", () => {
	it("names the agents above it as a breadcrumb at depth four, and a crumb selects its agent", () => {
		useWorkViewStore.getState().select("d");
		render(<WorkMain />);
		const crumbs = screen.getByRole("navigation", {
			name: t("work.detail.managers"),
		});
		expect(
			within(crumbs)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["Agent a", "Agent b", "Agent c"]);
		// The breadcrumb names the chain, so the row does not repeat it.
		expect(screen.queryByText("Agent a › Agent b › Agent c")).toBeNull();

		act(() => within(crumbs).getByRole("button", { name: "Agent b" }).click());
		expect(useWorkViewStore.getState().selected).toBe("b");
		expect(
			within(
				screen.getByRole("navigation", { name: t("work.detail.managers") }),
			)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["Agent a"]);
	});

	it("drills into the agents it manages the same way at every depth", () => {
		useWorkViewStore.getState().select("a");
		render(<WorkMain />);
		for (const [manager, child, below] of [
			["a", "b", 2],
			["b", "c", 1],
		] as const) {
			const managed = within(column(manager)).getByRole("region", {
				name: t("agents.team.label"),
			});
			// Each managed row sums up what it manages in turn.
			expect(
				within(managed).getByText(t("agents.row.manages", { n: below }), {
					exact: false,
				}),
			).toBeTruthy();
			act(() => within(managed).getByText(`Agent ${child}`).click());
			expect(useWorkViewStore.getState().selected).toBe(child);
			expect(columnKeys()).toEqual([child]);
		}
		// The deepest one manages none, so it has no managed list.
		act(() =>
			within(
				within(column("c")).getByRole("region", {
					name: t("agents.team.label"),
				}),
			)
				.getByText("Agent d")
				.click(),
		);
		expect(
			within(column("d")).queryByRole("region", {
				name: t("agents.team.label"),
			}),
		).toBeNull();
	});

	it("lists the other agents that manage it with where each fact comes from", () => {
		useStore.setState({
			agents: agents.map((candidate) =>
				candidate.id === "b"
					? {
							...candidate,
							runParent: {
								sessionId: "s-a",
								workspaceId: "workspace-1",
								leadAgentId: "solo",
							},
						}
					: candidate,
			),
		});
		useWorkViewStore.getState().select("b");
		render(<WorkMain />);
		const also = screen.getByText(t("work.detail.alsoManagedBy"))
			.parentElement as HTMLElement;
		expect(
			within(also).getByText(
				`(${t("work.detail.relationSource.runParentRecorded")})`,
			),
		).toBeTruthy();
		act(() => within(also).getByRole("button", { name: "Agent solo" }).click());
		expect(useWorkViewStore.getState().selected).toBe("solo");
	});

	it("shows a terminal agent's provider transcript read-only and never mounts a terminal", async () => {
		useWorkViewStore.getState().select("d");
		render(<WorkMain />);
		const conversation = screen.getByRole("region", {
			name: t("work.conversation.label"),
		});
		expect(await within(conversation).findByText("Fix the flaky test")).toBeTruthy();
		expect(mocks.read).toHaveBeenCalledTimes(1);
		expect(mocks.read).toHaveBeenCalledWith("codex", "conversation-d", {
			includeTools: true,
		});
		// No composer: typing happens in the large window.
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(mocks.terminal).not.toHaveBeenCalled();
	});

	it("says when there is no conversation record and offers the large window", () => {
		useWorkViewStore.getState().select("solo");
		render(<WorkMain />);
		const conversation = screen.getByRole("region", {
			name: t("work.conversation.label"),
		});
		expect(within(conversation).getByText(t("work.conversation.none"))).toBeTruthy();
		act(() =>
			within(conversation)
				.getByRole("button", { name: t("work.detail.openLargeWindow") })
				.click(),
		);
		// No pane holds it, so the large window takes over none.
		expect(mocks.open).toHaveBeenCalledWith("solo", "Agent solo", undefined);
		expect(mocks.read).not.toHaveBeenCalled();
		expect(mocks.terminal).not.toHaveBeenCalled();
	});

	it("reads a Chat agent's conversation through the shared session lease, without a composer", () => {
		useWorkViewStore.getState().select("chatty");
		render(<WorkMain />);
		expect(mocks.chatSession).toHaveBeenCalledWith("chatty", chatty.interactionProfile);
		expect(screen.getByText(t("agents.chat.connecting"))).toBeTruthy();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(mocks.terminal).not.toHaveBeenCalled();
	});
});

describe("pinned columns", () => {
	it("pins agents side by side, with the selection after them", () => {
		useWorkViewStore.getState().select("a");
		render(<WorkMain />);
		act(() =>
			within(column("a"))
				.getByRole("button", { name: t("work.detail.pin") })
				.click(),
		);
		expect(useWorkViewStore.getState().pinned).toEqual(["a"]);
		expect(columnKeys()).toEqual(["a"]);

		act(() => useWorkViewStore.getState().select("chatty"));
		expect(columnKeys()).toEqual(["a", "chatty"]);
		act(() =>
			within(column("chatty"))
				.getByRole("button", { name: t("work.detail.pin") })
				.click(),
		);
		expect(useWorkViewStore.getState().pinned).toEqual(["a", "chatty"]);
		// Selecting a pinned agent marks its column; it adds none.
		act(() => useWorkViewStore.getState().select("a"));
		expect(columnKeys()).toEqual(["a", "chatty"]);
		expect(column("a").getAttribute("aria-current")).toBe("true");

		act(() =>
			within(column("chatty"))
				.getByRole("button", { name: t("work.detail.moveLeft") })
				.click(),
		);
		expect(columnKeys()).toEqual(["chatty", "a"]);
		// Drilling in a pinned column selects; the pins stay as they are.
		act(() =>
			within(
				within(column("a")).getByRole("region", {
					name: t("agents.team.label"),
				}),
			)
				.getByText("Agent b")
				.click(),
		);
		expect(useWorkViewStore.getState().pinned).toEqual(["chatty", "a"]);
		expect(columnKeys()).toEqual(["chatty", "a", "b"]);
		// Each column holds only its own transcript read or session lease.
		expect(
			new Set(mocks.chatSession.mock.calls.map(([agentId]) => agentId)),
		).toEqual(new Set(["chatty"]));
		expect(mocks.terminal).not.toHaveBeenCalled();
	});

	it("keeps a pinned agent that was removed until the person unpins it", () => {
		useWorkViewStore.setState({ pinned: ["gone", "solo"] });
		render(<WorkMain />);
		const removed = column("gone");
		expect(within(removed).getByText(t("work.detail.removed"))).toBeTruthy();
		expect(columnKeys()).toEqual(["gone", "solo"]);
		fireEvent.click(
			within(removed).getByRole("button", { name: t("work.detail.unpin") }),
		);
		expect(useWorkViewStore.getState().pinned).toEqual(["solo"]);
		expect(columnKeys()).toEqual(["solo"]);
	});
});
