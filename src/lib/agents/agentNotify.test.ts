import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	agentNoticeAdmit: vi.fn(),
	notifyAgentEvent: vi.fn(),
}));

vi.mock("@/lib/ipc/notifications", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/notifications")>()),
	agentNoticeAdmit: mocks.agentNoticeAdmit,
}));
vi.mock("@/lib/agents/agentAttentionNotifier", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agents/agentAttentionNotifier")>()),
	notifyAgentEvent: mocks.notifyAgentEvent,
}));

import {
	dispatchCliAgentNotifyRequest,
	handleAgentNotify,
} from "@/lib/agents/agentNotify";
import { useStore } from "@/store";
import type { Agent } from "@/types";

const managedAgent = {
	id: "agent-a",
	name: "Codex",
	projectId: "project-a",
	sessionId: "pane-session-a",
	runtimeBinding: { runtime: "hmux_managed_v1", sessionId: "managed_0123abcd" },
} as unknown as Agent;
const chatAgent = {
	id: "agent-chat",
	name: "Claude",
	projectId: "project-a",
	provider: "claude",
	sessionId: "pane-session-b",
	interactionProfile: { kind: "structured_protocol", backendProfileId: "local" },
} as unknown as Agent;
const shown = {
	agent: { id: "agent-a", name: "Codex", project: "Workspace" },
	desktop: { status: "shown" },
	phone: { status: "not_sent", reason: "unsupported" },
};

beforeEach(() => {
	vi.clearAllMocks();
	useStore.setState({
		agents: [managedAgent, chatAgent],
		projects: [{ id: "project-a", name: "Workspace" }] as never,
	});
	mocks.agentNoticeAdmit.mockResolvedValue({ outcome: "admitted", notice: "n.0123" });
	mocks.notifyAgentEvent.mockResolvedValue(shown);
});

describe("handleAgentNotify", () => {
	it("admits the message under the agent's seat key and shows it as that agent's", async () => {
		const result = await handleAgentNotify({
			message: "Build is green",
			sessionId: "pane-session-a",
		});
		expect(mocks.agentNoticeAdmit).toHaveBeenCalledWith("managed_0123abcd", "Build is green");
		expect(mocks.notifyAgentEvent).toHaveBeenCalledWith("agent-a", "message", "Build is green", {
			eventId: "notify:n.0123",
		});
		expect(result).toEqual({ ok: true, status: "delivered", ...shown });
	});

	it("keys a chat-owned agent by the seat the phone lists it under", async () => {
		await handleAgentNotify({ message: "Hi", sessionId: "pane-session-b" });
		expect(mocks.agentNoticeAdmit).toHaveBeenCalledWith("agent-chat", "Hi");
		expect(mocks.notifyAgentEvent).toHaveBeenCalledWith("agent-chat", "message", "Hi", {
			eventId: "notify:n.0123",
		});
	});

	it.each([undefined, "unknown-session"])("sends as a person when session %s names no agent", async (sessionId) => {
		await handleAgentNotify({ message: "Hi", ...(sessionId ? { sessionId } : {}) });
		expect(mocks.agentNoticeAdmit).toHaveBeenCalledWith("person", "Hi");
		expect(mocks.notifyAgentEvent).toHaveBeenCalledWith(null, "message", "Hi", {
			eventId: "notify:n.0123",
		});
	});

	it("does not guess between two agents in one session", async () => {
		useStore.setState({ agents: [managedAgent, { ...chatAgent, sessionId: "pane-session-a" } as Agent] });
		await handleAgentNotify({ message: "Hi", sessionId: "pane-session-a" });
		expect(mocks.agentNoticeAdmit).toHaveBeenCalledWith("person", "Hi");
	});

	it("shows nothing and says when to retry once the sender is rate limited", async () => {
		mocks.agentNoticeAdmit.mockResolvedValue({ outcome: "rate_limited", retryAfterMs: 20_000 });
		const result = await handleAgentNotify({ message: "Hi", sessionId: "pane-session-a" });
		expect(mocks.notifyAgentEvent).not.toHaveBeenCalled();
		expect(result).toEqual({
			ok: true,
			status: "rate_limited",
			retryAfterMs: 20_000,
			agent: { id: "agent-a", name: "Codex", project: "Workspace" },
			desktop: { status: "not_sent", reason: "rate_limited" },
			phone: { status: "not_sent", reason: "rate_limited" },
		});
	});

	it("refuses text the admission refuses, with its reason", async () => {
		mocks.agentNoticeAdmit.mockResolvedValue({ outcome: "invalid", reason: "format_character" });
		const result = await handleAgentNotify({ message: "a‮b" });
		expect(mocks.notifyAgentEvent).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			error: { code: "notify_message_invalid", reason: "format_character" },
		});
	});

	it("reports not_delivered when no surface showed the message", async () => {
		mocks.notifyAgentEvent.mockResolvedValue({ ...shown, desktop: { status: "disabled" } });
		expect(await handleAgentNotify({ message: "Hi" })).toMatchObject({
			ok: true,
			status: "not_delivered",
			desktop: { status: "disabled" },
		});
	});

	it.each([
		{ message: 7 },
		{ message: "x".repeat(4097) },
		{ message: "Hi", sessionId: 3 },
		{ message: "Hi", sessionId: "pane\u001bsession" },
	])("refuses a malformed request %# before admission", async (params) => {
		expect(await handleAgentNotify(params)).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		expect(mocks.agentNoticeAdmit).not.toHaveBeenCalled();
	});
});

describe("dispatchCliAgentNotifyRequest", () => {
	const dependencies = () => ({
		claim: vi.fn(async () => true),
		complete: vi.fn(async () => undefined),
		isMainWindow: vi.fn(() => true),
	});

	it("leaves other actions to their own handlers", async () => {
		const deps = dependencies();
		expect(await dispatchCliAgentNotifyRequest({ reqId: "r", action: "spawn", params: {} }, deps)).toBe(false);
		expect(deps.claim).not.toHaveBeenCalled();
	});

	it("is claimed only by the main window, which owns notifications", async () => {
		const deps = dependencies();
		deps.isMainWindow.mockReturnValue(false);
		expect(await dispatchCliAgentNotifyRequest({ reqId: "r", action: "agent.notify", params: { message: "Hi" } }, deps)).toBe(true);
		expect(deps.claim).not.toHaveBeenCalled();
		expect(mocks.agentNoticeAdmit).not.toHaveBeenCalled();
	});

	it("completes the claimed request with the receipt", async () => {
		const deps = dependencies();
		await dispatchCliAgentNotifyRequest({ reqId: "r", action: "agent.notify", params: { message: "Hi" } }, deps);
		expect(deps.complete).toHaveBeenCalledWith("r", { ok: true, status: "delivered", ...shown }, "agent.notify");
	});

	it("turns an admission failure into a typed refusal instead of a timeout", async () => {
		const deps = dependencies();
		mocks.agentNoticeAdmit.mockRejectedValue(new Error("The notice limiter is unavailable"));
		await dispatchCliAgentNotifyRequest({ reqId: "r", action: "agent.notify", params: { message: "Hi" } }, deps);
		expect(deps.complete).toHaveBeenCalledWith(
			"r",
			{ ok: false, error: { code: "notify_failed", message: "The notice limiter is unavailable" } },
			"agent.notify",
		);
	});
});
