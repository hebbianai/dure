import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyChatHandoverNow,
	cancelChatHandover,
	chatHandoverInFlight,
	installChatHandoverWatch,
	requestChatHandover,
	setNativeAgentView,
} from "@/lib/agents/chatHandoverRuntime";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({ transition: vi.fn() }));
vi.mock("@/lib/agents/agentRuntimeTransitionAction", () => ({
	transitionAgentRuntime: (...args: unknown[]) => mocks.transition(...args),
}));

const AGENT_ID = "agent-claude";
const SESSION_ID = "session-claude";

function sourceBusy(revision = 7) {
	const code = "agent_runtime_source_busy";
	return new DureAgentRuntimeSourceActiveError(
		new DureBackendRequestError(code, "busy", {
			schemaVersion: 1,
			kind: "invalid",
			code,
			message: "busy",
		} as never),
		revision,
	);
}

function runtime(
	patch: Partial<HmuxAgentRuntimeState> = {},
): HmuxAgentRuntimeState {
	return {
		terminalEpoch: "epoch-1",
		revision: "4",
		observedThroughOutputSeq: "9",
		lifecycle: "running",
		activity: "working",
		attention: "none",
		source: "provider_event",
		turnCompletedCount: "2",
		...patch,
	};
}

function seedRuntime(state: HmuxAgentRuntimeState) {
	useStore.setState({ sessionAgentRuntimeState: { [SESSION_ID]: state } });
}

function current(): Agent | undefined {
	return useStore.getState().agents.find((agent) => agent.id === AGENT_ID);
}

/** What the real transition projects: the same conversation, now chat-owned. */
function becomeChatOwned() {
	useStore.setState((state) => ({
		agents: state.agents.map((agent) =>
			agent.id === AGENT_ID
				? {
						...agent,
						runtimeBinding: undefined,
						interactionProfile: {
							schemaVersion: 1,
							kind: "structured_protocol",
							backendProfileId: "local",
							interactionSessionId: "interaction-1",
						},
						pendingChatHandover: undefined,
						nativeView: undefined,
					}
				: agent,
		),
	}));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	mocks.transition.mockReset();
	useStore.setState({
		agents: [
			managedAgentFixture({
				id: AGENT_ID,
				provider: "claude",
				sessionId: SESSION_ID,
				conversationId: "conversation-1",
			}),
		],
	});
	seedRuntime(runtime());
});

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

describe("chat handover", () => {
	it("switches an idle terminal agent immediately", async () => {
		seedRuntime(runtime({ activity: "waiting" }));
		const switchRuntime = vi.fn().mockResolvedValue(undefined);
		await expect(requestChatHandover(AGENT_ID, switchRuntime)).resolves.toEqual(
			{ kind: "completed" },
		);
		expect(switchRuntime).toHaveBeenCalledTimes(1);
		expect(switchRuntime).toHaveBeenCalledWith("preserve");
		expect(current()?.pendingChatHandover).toBeUndefined();
	});

	it("schedules a busy agent's move instead of discarding, then switches when the turn ends", async () => {
		const switchRuntime = vi.fn().mockRejectedValueOnce(sourceBusy());
		await expect(requestChatHandover(AGENT_ID, switchRuntime)).resolves.toEqual(
			{ kind: "scheduled" },
		);
		expect(switchRuntime).toHaveBeenCalledTimes(1);
		expect(switchRuntime).toHaveBeenCalledWith("preserve");
		expect(current()?.pendingChatHandover).toMatchObject({
			baselineSessionId: SESSION_ID,
			baselineRuntimeRevision: "4",
		});

		mocks.transition.mockImplementation(async () => becomeChatOwned());
		dispose = installChatHandoverWatch();
		// Still working: nothing runs.
		seedRuntime(runtime({ revision: "5" }));
		await flush();
		expect(mocks.transition).not.toHaveBeenCalled();

		// The turn ends: the existing transition runs once, preserving the source.
		seedRuntime(runtime({ revision: "6", activity: "waiting" }));
		await flush();
		expect(mocks.transition).toHaveBeenCalledTimes(1);
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: AGENT_ID,
			targetInteractionProfile: "structured_protocol",
			sourceStopPolicy: "preserve",
			expectedSourceRevision: undefined,
			credentialAction: { targetCredentialId: null },
		});
		expect(current()?.interactionProfile?.kind).toBe("structured_protocol");
		expect(current()?.conversationId).toBe("conversation-1");
		expect(current()?.pendingChatHandover).toBeUndefined();
		expect(chatHandoverInFlight(AGENT_ID)).toBe(false);
	});

	it("waits again after a busy refusal at the idle boundary and never discards", async () => {
		await requestChatHandover(
			AGENT_ID,
			vi.fn().mockRejectedValueOnce(sourceBusy()),
		);
		mocks.transition.mockRejectedValueOnce(sourceBusy());
		dispose = installChatHandoverWatch();
		seedRuntime(runtime({ revision: "5", activity: "waiting" }));
		await flush();
		expect(mocks.transition).toHaveBeenCalledTimes(1);
		expect(current()?.pendingChatHandover).toMatchObject({
			baselineRuntimeRevision: "5",
		});
		expect(current()?.pendingChatHandover?.lastError).toBeUndefined();

		// The same snapshot does not retry; the next idle boundary does.
		useStore.setState((state) => ({ agents: [...state.agents] }));
		await flush();
		expect(mocks.transition).toHaveBeenCalledTimes(1);
		mocks.transition.mockImplementationOnce(async () => becomeChatOwned());
		seedRuntime(runtime({ revision: "7", activity: "waiting" }));
		await flush();
		expect(mocks.transition).toHaveBeenCalledTimes(2);
		for (const [request] of mocks.transition.mock.calls) {
			expect(request).toMatchObject({ sourceStopPolicy: "preserve" });
		}
		expect(current()?.pendingChatHandover).toBeUndefined();
	});

	it("keeps a hard failure visible instead of retrying it", async () => {
		await requestChatHandover(
			AGENT_ID,
			vi.fn().mockRejectedValueOnce(sourceBusy()),
		);
		mocks.transition.mockRejectedValueOnce(
			new Error("agent_runtime_target_unavailable"),
		);
		dispose = installChatHandoverWatch();
		seedRuntime(runtime({ revision: "5", activity: "waiting" }));
		await flush();
		expect(current()?.pendingChatHandover?.lastError).toBe(
			"agent_runtime_target_unavailable",
		);
		seedRuntime(runtime({ revision: "6", activity: "waiting" }));
		await flush();
		expect(mocks.transition).toHaveBeenCalledTimes(1);
	});

	it("cancels a scheduled move so the next idle boundary does nothing", async () => {
		await requestChatHandover(
			AGENT_ID,
			vi.fn().mockRejectedValueOnce(sourceBusy()),
		);
		expect(cancelChatHandover(AGENT_ID)).toBe(true);
		dispose = installChatHandoverWatch();
		seedRuntime(runtime({ revision: "5", activity: "waiting" }));
		await flush();
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(current()?.pendingChatHandover).toBeUndefined();
	});

	it("resumes a persisted move after reload once runtime projection arrives", async () => {
		await requestChatHandover(
			AGENT_ID,
			vi.fn().mockRejectedValueOnce(sourceBusy()),
		);
		useStore.setState({ sessionAgentRuntimeState: {} });
		mocks.transition.mockImplementation(async () => becomeChatOwned());
		dispose = installChatHandoverWatch();
		await flush();
		expect(mocks.transition).not.toHaveBeenCalled();
		seedRuntime(runtime({ revision: "9", activity: "waiting" }));
		await flush();
		expect(mocks.transition).toHaveBeenCalledTimes(1);
	});

	it("discards only on the explicit switch-now choice, fenced by the refused revision", async () => {
		await requestChatHandover(
			AGENT_ID,
			vi.fn().mockRejectedValueOnce(sourceBusy()),
		);
		const switchRuntime = vi
			.fn()
			.mockRejectedValueOnce(sourceBusy(11))
			.mockResolvedValueOnce(undefined);
		await applyChatHandoverNow(AGENT_ID, switchRuntime);
		expect(switchRuntime.mock.calls).toEqual([
			["preserve"],
			["discard", 11],
		]);
		expect(current()?.pendingChatHandover).toBeUndefined();
	});

	it("remembers the observer view on the agent record", () => {
		setNativeAgentView(AGENT_ID, "conversation");
		expect(current()?.nativeView).toBe("conversation");
		setNativeAgentView(AGENT_ID, "terminal");
		expect(current()?.nativeView).toBe("terminal");
	});
});
