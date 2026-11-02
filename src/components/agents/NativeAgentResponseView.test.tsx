// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPage } from "@/components/settings/TerminalPage";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { t } from "@/lib/i18n";
import {
	normalizePersistedState,
	persistedSlice,
} from "@/lib/persistence/persistedAppState";
import { NATIVE_AGENT_PENDING_IDLE_GRACE_MS } from "@/lib/agents/chat/nativeAgentChat";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Agent } from "@/types";
import { NativeAgentResponseView } from "./NativeAgentResponseView";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	send: vi.fn(),
	mounted: vi.fn(),
	unmounted: vi.fn(),
}));
vi.mock("@/lib/ipc/conversations", () => ({
	readProviderConversationTranscript: (...args: unknown[]) =>
		mocks.read(...args),
}));
vi.mock("@/lib/ipc/dureAgentNativeInput", () => ({
	sendNativeAgentPrompt: (...args: unknown[]) => mocks.send(...args),
}));
vi.mock("@/components/agents/chat/ChatMarkdown", () => ({
	ChatMarkdown: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}));

const agent = {
	...managedAgentFixture(),
	id: "agent-one",
	provider: "codex",
	sessionId: "session-one",
	sessionKind: "pty",
	runtimeBinding: managedBindingFixture({
		sessionId: "session-one",
		workspaceId: "workspace-one",
		conversationIdentity: {
			...stopFenceFixture({ terminalEpoch: "epoch-one" }),
			schemaVersion: 1,
			sessionId: "session-one",
			workspaceId: "workspace-one",
			revision: "1",
			observedThroughOutputSeq: "1",
			source: "provider_event",
			providerId: "codex",
			conversationId: "conversation-one",
		},
	}),
} as Agent;
function Terminal() {
	useEffect(() => {
		mocks.mounted();
		return () => {
			mocks.unmounted();
		};
	}, []);
	return <input aria-label="Native prompt" defaultValue="unsent draft" />;
}
const view = (current = agent, disabled = false) => (
	<NativeAgentResponseView agent={current} disabled={disabled}>
		<Terminal />
	</NativeAgentResponseView>
);
const reply = (
	conversationId = "conversation-one",
	finalResponse = "Final answer",
) => ({
	schemaVersion: 1,
	provider: "codex",
	conversationId,
	historyComplete: true,
	finalResponse,
	entries: [{ role: "agent", text: "Tool preamble" }],
});
function runtime(
	state: AgentDisplayState,
	count = "1",
	terminalEpoch = "epoch-one",
) {
	act(() => {
		useAgentAttention.setState({ displayStates: { [agent.id]: state } });
		useStore.setState({
			sessionAgentRuntimeState: {
				[agent.sessionId]: {
					terminalEpoch,
					revision: "1",
					observedThroughOutputSeq: "1",
					source: "provider_event",
					lifecycle: "running",
					activity: state === "working" ? "working" : "waiting",
					attention:
						state === "blocked"
							? "approval_required"
							: state === "error"
								? "error"
								: "none",
					turnCompletedCount: count,
				},
			},
		});
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("PROD", false);
	vi.stubEnv("VITE_DURE_INTERFACE_MODE_POLICY", "");
	useStore
		.getState()
		.setUiPrefs({ interfaceMode: "pro", agentFinalResponseOnly: true });
	mocks.read.mockResolvedValue(reply());
	runtime("waiting");
});
afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
});

describe("Pro final response presentation", () => {
	it("does not cover a terminal with another generation's conversation identity", () => {
		runtime("waiting", "1", "epoch-replacement");
		render(view());
		expect(screen.getByRole("textbox")).toBeTruthy();
		expect(mocks.read).not.toHaveBeenCalled();
	});
	it("does not flash the previous final answer after an interrupted next request", async () => {
		render(view());
		await screen.findByText("Final answer");
		runtime("working");
		mocks.read.mockResolvedValue({ ...reply(), finalResponse: null });
		runtime("waiting");
		expect(screen.queryByText("Final answer")).toBeNull();
		await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
	});
	it("applies the settings toggle immediately, persists it, and keeps the native draft mounted", async () => {
		render(
			<>
				<TerminalPage />
				{view()}
			</>,
		);
		await screen.findByText("Final answer");
		expect(screen.queryByText("Tool preamble")).toBeNull();
		expect(screen.queryByRole("textbox", { name: "Native prompt" })).toBeNull();
		const toggle = screen.getByRole("switch", {
			name: t("settings.terminal.finalResponseOnly.title"),
		});
		fireEvent.click(toggle);
		expect(screen.getByRole("textbox")).toHaveProperty("value", "unsent draft");
		expect(
			normalizePersistedState(
				JSON.parse(JSON.stringify(persistedSlice(useStore.getState()))),
			),
		).toHaveProperty("uiPrefs.agentFinalResponseOnly", false);
		fireEvent.click(toggle);
		await screen.findByText("Final answer");
		expect(
			normalizePersistedState(
				JSON.parse(JSON.stringify(persistedSlice(useStore.getState()))),
			),
		).toHaveProperty("uiPrefs.agentFinalResponseOnly", true);
		expect(mocks.mounted).toHaveBeenCalledTimes(1);
		expect(mocks.unmounted).not.toHaveBeenCalled();
	});
	it("hides both the setting and presentation after switching to Basic, retaining the saved preference", async () => {
		render(
			<>
				<TerminalPage />
				{view()}
			</>,
		);
		await screen.findByText("Final answer");
		act(() => useStore.getState().setUiPrefs({ interfaceMode: "basic" }));
		expect(
			screen.queryByRole("switch", {
				name: t("settings.terminal.finalResponseOnly.title"),
			}),
		).toBeNull();
		expect(screen.getByRole("textbox")).toBeTruthy();
		expect(useStore.getState().uiPrefs.agentFinalResponseOnly).toBe(true);
	});
	it("obeys Basic-only build policy even with a saved Beta preference", () => {
		vi.stubEnv("VITE_DURE_INTERFACE_MODE_POLICY", "basic-only");
		render(
			<>
				<TerminalPage />
				{view()}
			</>,
		);
		expect(
			screen.queryByRole("switch", {
				name: t("settings.terminal.finalResponseOnly.title"),
			}),
		).toBeNull();
		expect(screen.getByRole("textbox")).toBeTruthy();
		expect(mocks.read).not.toHaveBeenCalled();
	});
	it("shows quiet work, allows native input, and refreshes after the next Host completion", async () => {
		runtime("working", "0");
		render(view());
		expect(screen.getByRole("status").textContent).toBe(t("common.working"));
		expect(mocks.read).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", {
				name: t("agents.finalResponse.continueInTerminal"),
			}),
		);
		expect(screen.getByRole("textbox")).toBeTruthy();
		runtime("waiting");
		await screen.findByText("Final answer");
		mocks.read.mockResolvedValue(reply("conversation-one", "Second answer"));
		runtime("waiting", "2");
		await screen.findByText("Second answer");
		expect(screen.queryByText("Final answer")).toBeNull();
	});
	it.each(["blocked", "input", "error", "unknown", "exited"] as const)(
		"exposes native interaction on %s",
		async (state) => {
			render(view());
			await screen.findByText("Final answer");
			runtime(state);
			expect(screen.getByRole("textbox")).toBeTruthy();
		},
	);
	it("cannot show a late response from a replaced conversation", async () => {
		let resolve!: (value: ReturnType<typeof reply>) => void;
		mocks.read.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const mounted = render(view());
		mocks.read.mockResolvedValue(reply("conversation-two", "New answer"));
		mounted.rerender(
			view({
				...agent,
				runtimeBinding: {
					...agent.runtimeBinding,
					conversationIdentity: {
						providerId: "codex",
						conversationId: "conversation-two",
						terminalEpoch: "epoch-one",
					},
				},
			} as Agent),
		);
		await screen.findByText("New answer");
		await act(async () => resolve(reply("conversation-one", "Stale answer")));
		expect(screen.queryByText("Stale answer")).toBeNull();
	});
	it("keeps recovery, unsupported providers, and remote terminals usable", () => {
		const mounted = render(view(agent, true));
		expect(screen.getByRole("textbox")).toBeTruthy();
		mounted.rerender(view({ ...agent, provider: "gemini" }));
		expect(screen.getByRole("textbox")).toBeTruthy();
		mounted.rerender(
			view({
				...agent,
				runtimeBinding: { ...agent.runtimeBinding, source: "ssh" },
			} as Agent),
		);
		expect(screen.getByRole("textbox")).toBeTruthy();
		expect(mocks.read).not.toHaveBeenCalled();
	});
	it.each([null, "reject"])(
		"exposes the terminal when final text is unavailable (%s)",
		async (result) => {
			if (result === "reject")
				mocks.read.mockRejectedValue(new Error("read failed"));
			else mocks.read.mockResolvedValue({ ...reply(), finalResponse: null });
			render(view());
			await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
		},
	);
});

describe("Pro conversation view", () => {
	const conversationName = () => t("agents.nativeChat.conversation");
	const history = (
		entries: Array<{ role: "user" | "agent"; text: string }> = [],
	) => ({
		...reply(),
		finalResponse: "Second answer",
		entries: [
			{ role: "user", text: "First question" },
			{ role: "agent", text: "First answer" },
			...entries,
		],
	});
	const composer = () =>
		screen.getByRole("textbox", {
			name: t("agents.chat.composerLabel"),
		}) as HTMLTextAreaElement;
	const send = () =>
		screen.getByRole("button", {
			name: t("agents.chat.send"),
		}) as HTMLButtonElement;
	const showConversation = () =>
		fireEvent.click(screen.getByRole("radio", { name: conversationName() }));
	const showTerminal = () =>
		fireEvent.click(screen.getByRole("radio", { name: t("common.terminal") }));
	const nativePrompt = () =>
		screen.queryByRole("textbox", { name: "Native prompt" });
	const sendPrompt = async (text: string) => {
		fireEvent.change(composer(), { target: { value: text } });
		fireEvent.click(send());
		await screen.findByText(t("agents.nativeChat.reason.pending"));
	};

	beforeEach(() => {
		// jsdom has no layout; expose a visible viewport to the real virtualizer.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.hasAttribute("data-index") ? 32 : 600;
			},
		);
		useStore.getState().setUiPrefs({ agentFinalResponseOnly: false });
		useStore.setState({ chatDrafts: {} });
		mocks.read.mockResolvedValue(history());
		mocks.send.mockResolvedValue({ terminalEpoch: "epoch-one", recordId: "1" });
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("flips between the terminal and the conversation without losing either", async () => {
		render(view());
		expect(screen.getByRole("textbox", { name: "Native prompt" })).toBeTruthy();
		showConversation();
		await screen.findByText("First answer");
		expect(screen.getByText("First question")).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "Native prompt" })).toBeNull();
		fireEvent.change(composer(), { target: { value: "draft prompt" } });

		fireEvent.click(
			screen.getByRole("button", {
				name: t("agents.finalResponse.continueInTerminal"),
			}),
		);
		expect(
			screen.getByRole("textbox", { name: "Native prompt" }),
		).toHaveProperty("value", "unsent draft");
		expect(screen.queryByText("First answer")).toBeNull();

		showConversation();
		await screen.findByText("First answer");
		expect(composer().value).toBe("draft prompt");
		fireEvent.click(screen.getByRole("radio", { name: t("common.terminal") }));
		expect(screen.getByRole("textbox", { name: "Native prompt" })).toBeTruthy();
		expect(mocks.mounted).toHaveBeenCalledTimes(1);
		expect(mocks.unmounted).not.toHaveBeenCalled();
		// The pane kept the read; flipping at the same cursor does not repeat it.
		expect(mocks.read).toHaveBeenCalledTimes(1);
	});

	it("sends at an idle prompt and keeps it pending until the transcript has it", async () => {
		runtime("waiting", "1");
		render(view());
		showConversation();
		await screen.findByText("First answer");
		fireEvent.change(composer(), { target: { value: "Third question" } });
		fireEvent.click(send());

		await waitFor(() =>
			expect(mocks.send).toHaveBeenCalledWith(
				{
					agentId: "agent-one",
					backendProfileId: "local",
					expectedTerminalEpoch: "epoch-one",
				},
				"Third question",
			),
		);
		await screen.findByText(t("agents.nativeChat.reason.pending"));
		expect(screen.getByText("Third question")).toBeTruthy();
		expect(composer().value).toBe("");
		expect(send().disabled).toBe(true);

		runtime("working", "1");
		await screen.findByText(t("agents.nativeChat.reason.working"));
		expect(screen.getByText("Third question")).toBeTruthy();

		mocks.read.mockResolvedValue(
			history([
				{ role: "user", text: "Third question" },
				{ role: "agent", text: "Third answer" },
			]),
		);
		runtime("waiting", "2");
		await screen.findByText("Third answer");
		expect(screen.getAllByText("Third question")).toHaveLength(1);
		expect(
			screen.queryByText(t("agents.nativeChat.reason.pending")),
		).toBeNull();
		fireEvent.change(composer(), { target: { value: "Fourth" } });
		await waitFor(() => expect(send().disabled).toBe(false));
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});

	it("explains a closed composer and shows a Host refusal inline", async () => {
		runtime("working", "1");
		render(view());
		showConversation();
		await screen.findByText("First answer");
		expect(
			screen.getByText(t("agents.nativeChat.reason.working")),
		).toBeTruthy();

		runtime("blocked", "1");
		await screen.findByText(t("agents.nativeChat.reason.attention"));

		mocks.send.mockRejectedValueOnce({ code: "hmux_agent_prompt_refused" });
		fireEvent.change(composer(), { target: { value: "Try now" } });
		expect(send().disabled).toBe(true);
		runtime("waiting", "1");
		await waitFor(() => expect(send().disabled).toBe(false));
		fireEvent.click(send());
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain(t("agents.nativeChat.error.refused"));
		expect(alert.textContent).toContain("hmux_agent_prompt_refused");
		expect(composer().value).toBe("Try now");
	});

	it("re-reads for a new presentation owner instead of staying on loading", async () => {
		const mounted = render(view());
		showConversation();
		await screen.findByText("First answer");
		expect(mocks.read).toHaveBeenCalledTimes(1);
		mounted.rerender(
			view({
				...agent,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-b",
					credential_generation: "2",
				},
			}),
		);
		await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
		await screen.findByText("First answer");
		expect(screen.queryByText(t("common.loading"))).toBeNull();
	});

	it("lets a draft be typed while the agent works and sends only at an idle prompt", async () => {
		runtime("working", "1");
		render(view());
		showConversation();
		await screen.findByText("First answer");
		expect(composer().disabled).toBe(false);
		fireEvent.change(composer(), { target: { value: "Next step" } });
		expect(composer().value).toBe("Next step");
		expect(send().disabled).toBe(true);
		fireEvent.keyDown(composer(), { key: "Enter" });
		expect(mocks.send).not.toHaveBeenCalled();

		runtime("waiting", "1");
		await waitFor(() => expect(send().disabled).toBe(false));
		fireEvent.keyDown(composer(), { key: "Enter" });
		await waitFor(() =>
			expect(mocks.send).toHaveBeenCalledWith(
				expect.objectContaining({ agentId: "agent-one" }),
				"Next step",
			),
		);
	});

	it("keeps the draft in the shared draft store across a pane remount", async () => {
		const first = render(view());
		showConversation();
		await screen.findByText("First answer");
		fireEvent.change(composer(), { target: { value: "Moving draft" } });
		expect(useStore.getState().chatDrafts["agent-one"]).toEqual({
			[JSON.stringify(["local", "native:agent-one"])]: {
				text: "Moving draft",
				attachments: [],
			},
		});
		first.unmount();

		render(view());
		showConversation();
		await screen.findByText("First answer");
		expect(composer().value).toBe("Moving draft");
	});

	it("reopens the composer after a TUI-only input once the runtime stays idle, keeping the row as sent", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			render(view());
			showConversation();
			await screen.findByText("First answer");
			await sendPrompt("/help");
			expect(mocks.send).toHaveBeenCalledWith(expect.anything(), "/help");

			// The Host stays at its idle prompt; no turn and no transcript entry.
			await act(async () => {
				vi.advanceTimersByTime(NATIVE_AGENT_PENDING_IDLE_GRACE_MS - 500);
			});
			expect(
				screen.getByText(t("agents.nativeChat.reason.pending")),
			).toBeTruthy();
			expect(screen.getByText("/help")).toBeTruthy();

			await act(async () => {
				vi.advanceTimersByTime(1_000);
			});
			expect(
				screen.queryByText(t("agents.nativeChat.reason.pending")),
			).toBeNull();
			// The sent row stays; only the composer reopens.
			expect(screen.getByText("/help")).toBeTruthy();
			fireEvent.change(composer(), { target: { value: "/status" } });
			expect(send().disabled).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a repeated prompt pending when the first read failed, showing it once", async () => {
		mocks.read.mockRejectedValueOnce(new Error("read failed"));
		render(view());
		showConversation();
		await screen.findByText(t("agents.nativeChat.transcriptUnavailable"));
		// The transcript (once readable) already ends with this same text.
		await sendPrompt("First question");

		runtime("working", "1");
		await screen.findByText("First answer");
		runtime("waiting", "1");
		await screen.findByText(t("agents.nativeChat.reason.pending"));
		expect(screen.getAllByText("First question")).toHaveLength(1);
		fireEvent.change(composer(), { target: { value: "again" } });
		expect(send().disabled).toBe(true);
	});

	it("does not settle a real prompt early while the agent works on it", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			render(view());
			showConversation();
			await screen.findByText("First answer");
			await sendPrompt("Long task");
			runtime("working", "1");
			await act(async () => {
				vi.advanceTimersByTime(NATIVE_AGENT_PENDING_IDLE_GRACE_MS * 3);
			});
			expect(screen.getByText("Long task")).toBeTruthy();
			expect(
				screen.getByText(t("agents.nativeChat.reason.working")),
			).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a pending prompt through a brief runtime transition and never offers it again", async () => {
		let confirm!: (value: unknown) => void;
		mocks.send.mockImplementationOnce(
			() =>
				new Promise((done) => {
					confirm = done;
				}),
		);
		const mounted = render(view());
		showConversation();
		await screen.findByText("First answer");
		fireEvent.change(composer(), { target: { value: "Only once" } });
		fireEvent.click(send());
		await screen.findByText(t("agents.nativeChat.reason.sending"));

		// A transition (resume / runtime switch) hides the conversation view
		// while the Host write is still in flight.
		mounted.rerender(view(agent, true));
		expect(screen.queryByText(conversationName())).toBeNull();
		await act(async () =>
			confirm({ terminalEpoch: "epoch-one", recordId: "1" }),
		);

		// The runtime projection also drops for a moment (reconnect).
		act(() => useStore.setState({ sessionAgentRuntimeState: {} }));
		mounted.rerender(view());
		runtime("waiting", "1");

		await screen.findByText(t("agents.nativeChat.reason.pending"));
		expect(screen.getByText("Only once")).toBeTruthy();
		fireEvent.change(composer(), { target: { value: "Only once" } });
		expect(send().disabled).toBe(true);
		fireEvent.keyDown(composer(), { key: "Enter" });
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});

	it("shows the terminal itself when asked, even with final-response-only on", async () => {
		useStore.getState().setUiPrefs({ agentFinalResponseOnly: true });
		mocks.read.mockResolvedValue(history());
		render(view());
		// The final-response overlay covers the terminal at rest.
		await screen.findByText("Second answer");
		expect(nativePrompt()).toBeNull();

		showConversation();
		await screen.findByText("First answer");
		fireEvent.click(
			screen.getByRole("button", {
				name: t("agents.finalResponse.continueInTerminal"),
			}),
		);
		expect(nativePrompt()).toBeTruthy();
		expect(screen.queryByText("Second answer")).toBeNull();
		expect(
			screen.getByRole("radio", { name: t("common.terminal") }),
		).toHaveProperty("ariaChecked", "true");

		showConversation();
		await screen.findByText("First answer");
		showTerminal();
		expect(nativePrompt()).toBeTruthy();
		expect(screen.queryByText("Second answer")).toBeNull();
	});

	it("reveals the terminal from the toggle while the final-response overlay covers it", async () => {
		useStore.getState().setUiPrefs({ agentFinalResponseOnly: true });
		render(view());
		await screen.findByText("Second answer");
		expect(nativePrompt()).toBeNull();
		showTerminal();
		expect(nativePrompt()).toBeTruthy();
		expect(screen.queryByText("Second answer")).toBeNull();
	});

	it("keeps the view toggle in its own row, off the live terminal", async () => {
		const mounted = render(view());
		const group = screen.getByRole("radiogroup", {
			name: t("agents.runtime.viewLabel"),
		});
		const terminal = nativePrompt() as HTMLElement;
		// Nothing between the toggle and the view root is an overlay, and the
		// terminal's own frame does not contain it.
		expect(group.closest(".absolute")).toBeNull();
		const terminalFrame = terminal.closest(".relative") as HTMLElement;
		expect(terminalFrame.contains(group)).toBe(false);
		const row = terminalFrame.previousElementSibling as HTMLElement;
		expect(row.contains(group)).toBe(true);

		// A transition hides the toggle but keeps its row, so the terminal is
		// not resized by it.
		mounted.rerender(view(agent, true));
		expect(screen.queryByRole("radiogroup")).toBeNull();
		expect(terminalFrame.previousElementSibling).toBe(row);
		expect(mocks.mounted).toHaveBeenCalledTimes(1);
	});

	it("reserves the toggle row from launch, before the runtime binding is recorded", () => {
		const { runtimeBinding: _binding, ...unbound } = agent;
		const mounted = render(view({ ...unbound, conversationId: undefined }));
		const terminalFrame = (nativePrompt() as HTMLElement).closest(
			".relative",
		) as HTMLElement;
		const row = terminalFrame.previousElementSibling as HTMLElement;
		expect(row).toBeTruthy();
		expect(screen.queryByRole("radiogroup")).toBeNull();

		mounted.rerender(view());
		expect(terminalFrame.previousElementSibling).toBe(row);
		expect(
			row.contains(
				screen.getByRole("radiogroup", {
					name: t("agents.runtime.viewLabel"),
				}),
			),
		).toBe(true);
		expect(mocks.mounted).toHaveBeenCalledTimes(1);
	});

	it("shows a refusal's carried message instead of its raw token", async () => {
		mocks.send.mockRejectedValueOnce({
			code: "hmux_capability_missing",
			message: "This terminal cannot accept a prompt from the app.",
		});
		render(view());
		showConversation();
		await screen.findByText("First answer");
		fireEvent.change(composer(), { target: { value: "Hello" } });
		fireEvent.click(send());
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain(
			"This terminal cannot accept a prompt from the app.",
		);
		expect(alert.textContent).toContain("hmux_capability_missing");
		expect(composer().value).toBe("Hello");
	});

	it("is offered only for a live Pro local terminal of this generation", () => {
		const mounted = render(view());
		expect(
			screen.getByRole("radio", { name: conversationName() }),
		).toBeTruthy();
		mounted.rerender(view(agent, true));
		expect(
			screen.queryByRole("radio", { name: conversationName() }),
		).toBeNull();
		mounted.rerender(view());
		runtime("waiting", "1", "epoch-replacement");
		expect(
			screen.queryByRole("radio", { name: conversationName() }),
		).toBeNull();
		runtime("waiting", "1");
		act(() => useStore.getState().setUiPrefs({ interfaceMode: "basic" }));
		expect(
			screen.queryByRole("radio", { name: conversationName() }),
		).toBeNull();
		expect(mocks.send).not.toHaveBeenCalled();
	});
});
