// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { AgentPendingRequestV1 } from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
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
import { chatComposerSessionFixture } from "@/test/chatComposerSessionFixture";
import type { Agent, Project, Space } from "@/types";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	chatSession: vi.fn(),
	terminal: vi.fn(),
	open: vi.fn(),
	revealAgent: vi.fn(),
	send: vi.fn(),
	answer: vi.fn(),
}));
vi.mock("@/lib/ipc/dureAgentNativeInput", () => ({
	sendNativeAgentPrompt: (...args: unknown[]) => mocks.send(...args),
	answerNativeAgentApproval: (...args: unknown[]) => mocks.answer(...args),
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

const idleRuntime: HmuxAgentRuntimeState = {
	terminalEpoch: "epoch-d",
	revision: "1",
	observedThroughOutputSeq: "1",
	source: "provider_event",
	lifecycle: "running",
	activity: "waiting",
	attention: "none",
	turnCompletedCount: "1",
};

/** The Host's runtime for d, with the display state it implies. */
function runtimeOfD(
	patch: Partial<HmuxAgentRuntimeState>,
	display: "waiting" | "working" | "blocked" = "waiting",
) {
	act(() => {
		useStore.setState({
			sessionAgentRuntimeState: { "s-d": { ...idleRuntime, ...patch } },
		});
		useAgentAttention.setState({
			displayStates: {
				...useAgentAttention.getState().displayStates,
				d: display,
			},
		});
	});
}

/** A ready session for chatty, as the shared lease answers it. */
function chattySession(
	patch: Partial<AgentChatSessionView> = {},
	pendingRequests: AgentPendingRequestV1[] = [],
): AgentChatSessionView {
	const fixture = chatComposerSessionFixture("claude");
	const page = fixture.page!;
	return {
		...fixture,
		draftIdentity: {
			agentId: "chatty",
			backendProfileId: "local",
			interactionSessionId: "interaction-chatty",
		},
		page: {
			...page,
			binding: {
				...page.binding,
				agentId: "chatty",
				interactionSessionId: "interaction-chatty",
			},
			pendingRequests,
		},
		...patch,
	};
}

function permissionRequest(requestId: string): AgentPendingRequestV1 {
	return {
		interactionSessionId: "interaction-chatty",
		runtime: { runtimeGeneration: "runtime-1", providerEpoch: "query-1" },
		request: {
			requestId,
			kind: "permission",
			turnId: null,
			clientMessageId: "message-1",
			payload: { toolName: "Bash", input: { command: "pwd" } },
			createdAtMs: 1,
		},
	};
}

const composerOf = (scope: HTMLElement) =>
	within(scope).getByRole("textbox", {
		name: t("agents.chat.composerLabel"),
	}) as HTMLTextAreaElement;
const sendOf = (scope: HTMLElement) =>
	within(scope).getByRole("button", {
		name: t("agents.chat.send"),
	}) as HTMLButtonElement;

function column(key: string): HTMLElement {
	return document.querySelector<HTMLElement>(
		`[data-work-column="${key}"]`,
	) as HTMLElement;
}

/** A column's managed fold, when the agent manages any. */
function managedOf(key: string): HTMLElement | null {
	return within(column(key)).queryByRole("region", {
		name: t("agents.team.label"),
	});
}

function managedText(count: number, working: number): string {
	return [
		t("agents.row.manages", { n: count }),
		t("agents.row.managedWorking", { n: working }),
	].join(" · ");
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
		sessionAgentRuntimeState: { "s-d": idleRuntime },
		chatDrafts: {},
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
		draftIdentity: {
			agentId: "chatty",
			backendProfileId: "local",
			interactionSessionId: "interaction-chatty",
		},
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
	mocks.send.mockReset();
	mocks.send.mockResolvedValue({ terminalEpoch: "epoch-d", recordId: "1" });
	mocks.answer.mockReset();
	mocks.answer.mockResolvedValue({
		terminalEpoch: "epoch-d",
		attentionId: "attention-7",
	});
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

	it("labels the agents it manages and its conversation, says what it manages once, and shows no managed part for an agent that manages none", () => {
		useWorkViewStore.getState().select("a");
		render(<WorkMain />);
		const managed = managedOf("a") as HTMLElement;
		// The fold's line sums up the whole team below a, and only it does:
		// the card above does not say it again.
		expect(managed.querySelector("summary")?.textContent).toBe(managedText(3, 2));
		const card = column("a").querySelector("header") as HTMLElement;
		expect(card.textContent).not.toContain(
			t("agents.row.manages", { n: 3 }),
		);
		// Each row keeps to one line of what it was asked.
		expect(
			within(managed)
				.getAllByRole("button")
				.map((row) => row.getAttribute("data-variant")),
		).toEqual(["compact"]);
		const heading = within(column("a")).getByRole("heading", {
			name: t("work.conversation.label"),
		});
		const conversation = within(column("a")).getByRole("region", {
			name: t("work.conversation.label"),
		});
		// Header, managed list, then the labelled conversation.
		expect(
			managed.compareDocumentPosition(heading) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			heading.compareDocumentPosition(conversation) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		act(() => useWorkViewStore.getState().select("solo"));
		expect(managedOf("solo")).toBeNull();
		expect(
			within(column("solo")).getByRole("heading", {
				name: t("work.conversation.label"),
			}),
		).toBeTruthy();
	});

	it("folds the agents it manages once for every column, open by default", async () => {
		useWorkViewStore.setState({ pinned: ["a"], selected: "b" });
		render(<WorkMain />);
		const folds = () =>
			["a", "b"].map((key) => managedOf(key)?.querySelector("details"));
		expect(folds().map((fold) => fold?.open)).toEqual([true, true]);

		// Folding one column folds them all; only the line stays.
		fireEvent.click(managedOf("b")?.querySelector("summary") as HTMLElement);
		await waitFor(() =>
			expect(useWorkViewStore.getState().managedOpen).toBe(false),
		);
		expect(folds().map((fold) => fold?.open)).toEqual([false, false]);
		expect(within(managedOf("a") as HTMLElement).queryAllByRole("button")).toEqual(
			[],
		);
		expect(managedOf("b")?.textContent).toBe(managedText(2, 1));

		fireEvent.click(managedOf("a")?.querySelector("summary") as HTMLElement);
		await waitFor(() =>
			expect(useWorkViewStore.getState().managedOpen).toBe(true),
		);
		expect(folds().map((fold) => fold?.open)).toEqual([true, true]);
		expect(
			within(managedOf("b") as HTMLElement).getByText("Agent c"),
		).toBeTruthy();
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

	it("shows a terminal agent's provider transcript with its composer and never mounts a terminal", async () => {
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
		// Selecting the agent shows its composer but never focuses it.
		expect(document.activeElement).not.toBe(composerOf(conversation));
		expect(mocks.terminal).not.toHaveBeenCalled();
	});

	it("sends to a terminal agent at its idle prompt through the Host", async () => {
		useWorkViewStore.getState().select("d");
		render(<WorkMain />);
		const conversation = screen.getByRole("region", {
			name: t("work.conversation.label"),
		});
		await within(conversation).findByText("Fix the flaky test");
		fireEvent.change(composerOf(conversation), {
			target: { value: "Run it again" },
		});
		// The list's arrow keys stay the list's: typing here selects nothing.
		fireEvent.keyDown(composerOf(conversation), { key: "ArrowDown" });
		expect(useWorkViewStore.getState().selected).toBe("d");
		fireEvent.click(sendOf(conversation));
		await waitFor(() =>
			expect(mocks.send).toHaveBeenCalledWith(
				{
					agentId: "d",
					backendProfileId: "local",
					expectedTerminalEpoch: "epoch-d",
				},
				"Run it again",
			),
		);
		// The sent prompt shows until the transcript has it, and holds Send.
		expect(
			await within(conversation).findByText(
				t("agents.nativeChat.reason.pending"),
			),
		).toBeTruthy();
		expect(within(conversation).getByText("Run it again")).toBeTruthy();
		expect(composerOf(conversation).value).toBe("");
		expect(sendOf(conversation).disabled).toBe(true);
		expect(mocks.terminal).not.toHaveBeenCalled();
	});

	it("keeps a terminal agent's draft while it works and sends nothing until its prompt is idle", async () => {
		runtimeOfD({ activity: "working" }, "working");
		useWorkViewStore.getState().select("d");
		render(<WorkMain />);
		const conversation = screen.getByRole("region", {
			name: t("work.conversation.label"),
		});
		await within(conversation).findByText("Fix the flaky test");
		expect(
			within(conversation).getByText(t("agents.nativeChat.reason.working")),
		).toBeTruthy();
		fireEvent.change(composerOf(conversation), {
			target: { value: "Next step" },
		});
		expect(sendOf(conversation).disabled).toBe(true);
		fireEvent.keyDown(composerOf(conversation), { key: "Enter" });
		expect(mocks.send).not.toHaveBeenCalled();
		expect(composerOf(conversation).value).toBe("Next step");

		runtimeOfD({ turnCompletedCount: "2" });
		await waitFor(() => expect(sendOf(conversation).disabled).toBe(false));
		expect(composerOf(conversation).value).toBe("Next step");
	});

	it("answers a terminal agent's approval from the column", async () => {
		runtimeOfD(
			{
				attention: "approval_required",
				attentionId: "attention-7",
				approvalRequest: {
					toolName: "Bash",
					summary: "cargo test -p dure",
					choices: ["approve", "approve_always", "deny"],
				},
			},
			"blocked",
		);
		useWorkViewStore.getState().select("d");
		render(<WorkMain />);
		const conversation = screen.getByRole("region", {
			name: t("work.conversation.label"),
		});
		expect(
			await within(conversation).findByText(
				t("agents.nativeChat.approval.title", { tool: "Bash" }),
			),
		).toBeTruthy();
		expect(within(conversation).getByText("cargo test -p dure")).toBeTruthy();
		expect(sendOf(conversation).disabled).toBe(true);
		fireEvent.click(
			within(conversation).getByRole("button", { name: t("agents.chat.allow") }),
		);
		await waitFor(() =>
			expect(mocks.answer).toHaveBeenCalledWith(
				{
					agentId: "d",
					backendProfileId: "local",
					expectedTerminalEpoch: "epoch-d",
				},
				"attention-7",
				"approve",
			),
		);
	});

	it("sends what the column cannot answer to the large window", async () => {
		runtimeOfD({ attention: "input_required" }, "blocked");
		useWorkViewStore.getState().select("d");
		render(<WorkMain />);
		const conversation = screen.getByRole("region", {
			name: t("work.conversation.label"),
		});
		expect(
			await within(conversation).findByText(
				t("agents.nativeChat.reason.attention"),
			),
		).toBeTruthy();
		expect(sendOf(conversation).disabled).toBe(true);
		act(() =>
			within(conversation)
				.getByRole("button", {
					name: t("agents.finalResponse.continueInTerminal"),
				})
				.click(),
		);
		expect(mocks.open).toHaveBeenCalledWith("d", "Agent d", undefined);
		expect(mocks.terminal).not.toHaveBeenCalled();
	});

	it("offers no composer for a terminal agent that is not running or whose runtime is unknown", () => {
		for (const runtime of [
			{ ...idleRuntime, lifecycle: "exited" as const },
			{ ...idleRuntime, lifecycle: "starting" as const },
			undefined,
		]) {
			act(() =>
				useStore.setState({
					sessionAgentRuntimeState: runtime ? { "s-d": runtime } : {},
				}),
			);
			useWorkViewStore.getState().select("d");
			const mounted = render(<WorkMain />);
			const conversation = screen.getByRole("region", {
				name: t("work.conversation.label"),
			});
			expect(
				within(conversation).getByText(t("work.conversation.none")),
			).toBeTruthy();
			expect(within(conversation).queryByRole("textbox")).toBeNull();
			expect(
				within(conversation).getByRole("button", {
					name: t("work.detail.openLargeWindow"),
				}),
			).toBeTruthy();
			mounted.unmount();
		}
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("shows an ended terminal agent's last conversation once, read only", async () => {
		// The Host no longer has d's session, and d reads Exited.
		act(() => {
			useStore.setState({ sessionAgentRuntimeState: {} });
			useAgentAttention.setState({
				displayStates: {
					...useAgentAttention.getState().displayStates,
					d: "exited",
				},
			});
		});
		useWorkViewStore.getState().select("d");
		const mounted = render(<WorkMain />);
		const conversation = screen.getByRole("region", {
			name: t("work.conversation.label"),
		});
		expect(
			await within(conversation).findByText("Fix the flaky test"),
		).toBeTruthy();
		expect(mocks.read).toHaveBeenCalledWith("codex", "conversation-d", {
			includeTools: true,
		});
		expect(within(conversation).queryByRole("textbox")).toBeNull();
		// Nothing moves an ended conversation's cursor: what changes around it
		// reads nothing new.
		act(() =>
			useStore.setState({
				sessionAgentRuntimeState: {
					"s-a": { ...idleRuntime, activity: "working" },
				},
			}),
		);
		mounted.rerender(<WorkMain />);
		await within(conversation).findByText("Fix the flaky test");
		expect(mocks.read).toHaveBeenCalledTimes(1);
		expect(mocks.terminal).not.toHaveBeenCalled();
	});

	it("says there is no conversation record when an ended agent's history is gone", async () => {
		mocks.read.mockRejectedValue(
			new Error("provider conversation was not found"),
		);
		act(() => {
			useStore.setState({ sessionAgentRuntimeState: {} });
			useAgentAttention.setState({
				displayStates: {
					...useAgentAttention.getState().displayStates,
					d: "exited",
				},
			});
		});
		useWorkViewStore.getState().select("d");
		render(<WorkMain />);
		const conversation = screen.getByRole("region", {
			name: t("work.conversation.label"),
		});
		expect(
			await within(conversation).findByText(t("work.conversation.none")),
		).toBeTruthy();
		expect(within(conversation).queryByRole("alert")).toBeNull();
		expect(
			within(conversation).getByRole("button", {
				name: t("work.detail.openLargeWindow"),
			}),
		).toBeTruthy();
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

	it("reads a Chat agent's conversation through the shared session lease", () => {
		useWorkViewStore.getState().select("chatty");
		render(<WorkMain />);
		expect(mocks.chatSession).toHaveBeenCalledWith("chatty", chatty.interactionProfile);
		expect(screen.getByText(t("agents.chat.connecting"))).toBeTruthy();
		expect(mocks.terminal).not.toHaveBeenCalled();
	});

	it("sends to an idle Chat agent and steers into its running turn", () => {
		const idle = chattySession();
		mocks.chatSession.mockReturnValue(idle);
		useWorkViewStore.getState().select("chatty");
		const mounted = render(<WorkMain />);
		let conversation = screen.getByRole("region", {
			name: t("work.conversation.label"),
		});
		expect(document.activeElement).not.toBe(composerOf(conversation));
		fireEvent.change(composerOf(conversation), { target: { value: "Hello" } });
		fireEvent.keyDown(composerOf(conversation), { key: "Enter" });
		expect(idle.send).toHaveBeenCalledWith("Hello");
		expect(idle.steerOrQueue).not.toHaveBeenCalled();
		mounted.unmount();

		const running = chattySession({
			activeTurn: { turnId: "turn-1", clientMessageId: "message-1" },
		});
		mocks.chatSession.mockReturnValue(running);
		render(<WorkMain />);
		conversation = screen.getByRole("region", {
			name: t("work.conversation.label"),
		});
		fireEvent.change(composerOf(conversation), {
			target: { value: "Also check the docs" },
		});
		fireEvent.keyDown(composerOf(conversation), { key: "Enter" });
		expect(running.steerOrQueue).toHaveBeenCalledWith("Also check the docs");
		expect(running.send).not.toHaveBeenCalled();
		expect(mocks.terminal).not.toHaveBeenCalled();
	});

	it("answers a Chat agent's pending request in the column, without a team line", () => {
		// chatty manages one agent, so a team line would have something to show.
		useStore.setState({
			agents: [
				...agents,
				agent("helper", {
					projectId: "p-api",
					runParent: {
						sessionId: "s-unknown",
						workspaceId: "workspace-1",
						leadAgentId: "chatty",
					},
				}),
			],
		});
		const asking = chattySession({}, [permissionRequest("request-1")]);
		mocks.chatSession.mockReturnValue(asking);
		useWorkViewStore.getState().select("chatty");
		render(<WorkMain />);
		const conversation = screen.getByRole("region", {
			name: t("work.conversation.label"),
		});
		fireEvent.click(
			within(conversation).getByRole("button", { name: t("agents.chat.allow") }),
		);
		expect(asking.answerPending).toHaveBeenCalledWith("request-1", {
			decision: "allow",
		});
		// The managed list above is the column's team.
		expect(
			within(column("chatty")).getByRole("region", {
				name: t("agents.team.label"),
			}),
		).toBeTruthy();
		expect(
			column("chatty").querySelector('[data-slot="agent-team-line"]'),
		).toBeNull();
		expect(composerOf(conversation)).toBeTruthy();
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
