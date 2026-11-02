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
		screen.getByRole("button", { name: t("agents.chat.send") });
	const showConversation = () =>
		fireEvent.click(screen.getByRole("radio", { name: conversationName() }));

	beforeEach(() => {
		// jsdom has no layout; expose a visible viewport to the real virtualizer.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.hasAttribute("data-index") ? 32 : 600;
			},
		);
		useStore.getState().setUiPrefs({ agentFinalResponseOnly: false });
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
		expect(composer().disabled).toBe(true);

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
		await waitFor(() => expect(composer().disabled).toBe(false));
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});

	it("explains a closed composer and shows a Host refusal inline", async () => {
		runtime("working", "1");
		render(view());
		showConversation();
		await screen.findByText("First answer");
		expect(composer().disabled).toBe(true);
		expect(
			screen.getByText(t("agents.nativeChat.reason.working")),
		).toBeTruthy();

		runtime("blocked", "1");
		await screen.findByText(t("agents.nativeChat.reason.attention"));
		expect(composer().disabled).toBe(true);

		mocks.send.mockRejectedValueOnce({ code: "hmux_agent_prompt_refused" });
		runtime("waiting", "1");
		await waitFor(() => expect(composer().disabled).toBe(false));
		fireEvent.change(composer(), { target: { value: "Try now" } });
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
