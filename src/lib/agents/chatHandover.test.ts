import { describe, expect, it } from "vitest";
import {
	createPendingChatHandover,
	evaluatePendingChatHandover,
	normalizeNativeAgentView,
	normalizePendingChatHandover,
	rebaselinePendingChatHandover,
} from "@/lib/agents/chatHandover";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { managedAgentFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const agent = managedAgentFixture({ sessionId: "session-1" });

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

const busy = runtime();
const idleNext = runtime({ revision: "5", activity: "waiting" });

describe("pending chat handover", () => {
	it("waits on the busy observation it was refused at", () => {
		const intent = createPendingChatHandover(agent, busy, "request-1", 10);
		expect(evaluatePendingChatHandover(intent, agent, busy)).toEqual({
			kind: "waiting",
		});
		// The same revision reported idle cannot prove a new boundary.
		expect(
			evaluatePendingChatHandover(
				intent,
				agent,
				runtime({ activity: "waiting" }),
			),
		).toEqual({ kind: "waiting" });
	});

	it("is ready at the next authoritative idle turn boundary", () => {
		const intent = createPendingChatHandover(agent, busy, "request-1", 10);
		expect(evaluatePendingChatHandover(intent, agent, idleNext)).toEqual({
			kind: "ready",
		});
		expect(
			evaluatePendingChatHandover(
				intent,
				agent,
				runtime({ revision: "5", activity: "working" }),
			),
		).toEqual({ kind: "waiting" });
		expect(
			evaluatePendingChatHandover(
				intent,
				agent,
				runtime({
					revision: "5",
					activity: "waiting",
					attention: "approval_required",
				}),
			),
		).toEqual({ kind: "waiting" });
		expect(
			evaluatePendingChatHandover(
				intent,
				agent,
				runtime({ revision: "5", lifecycle: "exited" }),
			),
		).toEqual({ kind: "ready" });
	});

	it("waits for runtime projection and for a queued account switch", () => {
		const intent = createPendingChatHandover(agent, busy, "request-1", 10);
		expect(evaluatePendingChatHandover(intent, agent, undefined)).toEqual({
			kind: "waiting",
		});
		const withCredentialSwitch = {
			...agent,
			pendingCredentialSwitch: {},
		} as Agent;
		expect(
			evaluatePendingChatHandover(intent, withCredentialSwitch, idleNext),
		).toEqual({ kind: "waiting" });
	});

	it("is done once the agent is chat-owned, and stops after a hard failure", () => {
		const intent = createPendingChatHandover(agent, busy, "request-1", 10);
		const chatOwned = {
			...agent,
			runtimeBinding: undefined,
			interactionProfile: {
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
			},
		} as Agent;
		expect(evaluatePendingChatHandover(intent, chatOwned, idleNext)).toEqual({
			kind: "done",
		});
		expect(
			evaluatePendingChatHandover(
				{ ...intent, lastError: "agent_runtime_target_unavailable" },
				agent,
				idleNext,
			),
		).toEqual({ kind: "failed" });
	});

	it("rebaselines a busy refusal and clears the previous failure", () => {
		const intent = {
			...createPendingChatHandover(agent, busy, "request-1", 10),
			lastError: "chat_handover_failed",
		};
		const next = rebaselinePendingChatHandover(intent, agent, idleNext);
		expect(next).toEqual({
			schemaVersion: 1,
			requestId: "request-1",
			requestedAtMs: 10,
			baselineSessionId: "session-1",
			baselineTerminalEpoch: "epoch-1",
			baselineRuntimeRevision: "5",
		});
		expect(evaluatePendingChatHandover(next, agent, idleNext)).toEqual({
			kind: "waiting",
		});
	});

	it("normalizes persisted intents and views", () => {
		const intent = createPendingChatHandover(agent, undefined, "request-1", 10);
		expect(
			normalizePendingChatHandover(JSON.parse(JSON.stringify(intent))),
		).toEqual(intent);
		expect(
			normalizePendingChatHandover({ ...intent, requestId: "" }),
		).toBeUndefined();
		expect(
			normalizePendingChatHandover({ ...intent, schemaVersion: 2 }),
		).toBeUndefined();
		expect(normalizeNativeAgentView("conversation")).toBe("conversation");
		expect(normalizeNativeAgentView("terminal")).toBe("terminal");
		expect(normalizeNativeAgentView("chat")).toBeUndefined();
	});
});
