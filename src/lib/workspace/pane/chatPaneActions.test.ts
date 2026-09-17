import { describe, expect, it, vi } from "vitest";
import { chatPaneActionEntry } from "./chatPaneActions";
import { invokePaneAction, registerPaneActions } from "./paneActionRegistry";

const identity = {
	paneId: "agent:agent-1",
	agentId: "agent-1",
	conversationId: "conversation-1",
	interactionSessionId: "interaction-1",
};

const idle = {
	phase: "ready" as const,
	reconnecting: false,
	activeTurn: undefined,
	interrupting: false,
	locked: false,
	error: undefined,
};

describe("chatPaneActionEntry", () => {
	it("offers and awaits the exact failed-message handler without copying its input", async () => {
		let finish!: () => void;
		const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
		const entry = chatPaneActionEntry(identity, idle, {
			interrupt: vi.fn(),
			resendLastMessage: { failureId: "failed-message-1", run },
		});
		expect(entry.actions.resend_last_message).toBe(run);
		const remove = registerPaneActions({ ...entry, owner: {} });
		try {
			let settled = false;
			const request = invokePaneAction(identity.paneId, "resend_last_message").then((result) => {
				settled = true;
				return result;
			});
			await Promise.resolve();
			expect(run).toHaveBeenCalledExactlyOnceWith();
			expect(settled).toBe(false);
			finish();
			expect(await request).toEqual({ ok: true, paneId: identity.paneId, action: "resend_last_message" });
		} finally { remove(); }
	});

	it("does not offer resend during a turn, mutation, connection recovery or pane lock", () => {
		const handlers = { interrupt: vi.fn(), resendLastMessage: { failureId: "failed-1", run: vi.fn() } };
		for (const patch of [
			{ activeTurn: { turnId: "active" } },
			{ accountMovesLocked: true },
			{ locked: true },
			{ reconnecting: true },
			{ phase: "connecting" as const },
			{ phase: "error" as const },
			{ phase: "detached" as const },
		]) {
			expect(chatPaneActionEntry(identity, { ...idle, ...patch }, handlers).actions)
				.not.toHaveProperty("resend_last_message");
		}
		expect(chatPaneActionEntry(identity, idle, { interrupt: vi.fn() }).actions)
			.not.toHaveProperty("resend_last_message");
		expect(handlers.resendLastMessage.run).not.toHaveBeenCalled();
	});

	it("reports a resend failure without retrying or claiming successful submission", async () => {
		const run = vi.fn(async () => { throw new Error("agent_chat_turn_already_pending"); });
		const remove = registerPaneActions({
			...chatPaneActionEntry(identity, idle, {
				interrupt: vi.fn(), resendLastMessage: { failureId: "failed-1", run },
			}), owner: {},
		});
		try {
			expect(await invokePaneAction(identity.paneId, "resend_last_message")).toMatchObject({
				ok: false, error: { code: "pane_action_failed", message: "agent_chat_turn_already_pending" },
			});
			expect(run).toHaveBeenCalledOnce();
		} finally { remove(); }
	});

	it("projects an idle ready session with no actions and the copy-details context", () => {
		const entry = chatPaneActionEntry(identity, idle, { interrupt: vi.fn() });
		expect(entry).toEqual({
			paneId: "agent:agent-1",
			status: "idle",
			context:
				"agent=agent-1 pane=agent:agent-1 session=interaction-1 conversation=conversation-1",
			actions: {},
		});
	});

	it("offers interrupt exactly while a turn is active and not already interrupting", async () => {
		const interrupt = vi.fn().mockResolvedValue(undefined);
		const active = chatPaneActionEntry(
			identity,
			{ ...idle, activeTurn: { turnId: "turn-1" } },
			{ interrupt },
		);
		expect(active.status).toBe("turn_active");
		expect(Object.keys(active.actions)).toEqual(["interrupt"]);
		await active.actions.interrupt?.();
		expect(interrupt).toHaveBeenCalledTimes(1);

		const interrupting = chatPaneActionEntry(
			identity,
			{ ...idle, activeTurn: { turnId: "turn-1" }, interrupting: true },
			{ interrupt },
		);
		expect(interrupting.status).toBe("turn_active");
		expect(interrupting.actions).toEqual({});

		// The composer greys its stop button out during an account or
		// runtime-profile switch; the CLI must not keep offering it.
		const locked = chatPaneActionEntry(
			identity,
			{ ...idle, activeTurn: { turnId: "turn-1" }, locked: true },
			{ interrupt },
		);
		expect(locked.status).toBe("turn_active");
		expect(locked.actions).toEqual({});
	});

	it("reports a ready session that is backing off to resubscribe as connecting", () => {
		const entry = chatPaneActionEntry(
			identity,
			{
				...idle,
				reconnecting: true,
				activeTurn: { turnId: "turn-1" },
				error: "subscription dropped",
			},
			{ interrupt: vi.fn() },
		);
		expect(entry.status).toBe("connecting");
		expect(entry.error).toBe("subscription dropped");
		expect(entry.actions).toEqual({});
	});

	it("maps connection phases and carries the session error", () => {
		expect(chatPaneActionEntry(identity, { ...idle, phase: "connecting" }, { interrupt: vi.fn() }).status).toBe("connecting");
		expect(chatPaneActionEntry(identity, { ...idle, phase: "detached" }, { interrupt: vi.fn() }).status).toBe("detached");
		const failed = chatPaneActionEntry(
			identity,
			{ ...idle, phase: "error", error: "agent_conversation_provider_failed" },
			{ interrupt: vi.fn() },
		);
		expect(failed.status).toBe("error");
		expect(failed.error).toBe("agent_conversation_provider_failed");
		expect(failed.actions).toEqual({});
	});

	it("surfaces the newest turn failure reason on an idle pane as a typed error", () => {
		const entry = chatPaneActionEntry(
			identity,
			{ ...idle, lastTurnFailure: "usage_limit" },
			{ interrupt: vi.fn() },
		);
		expect(entry.status).toBe("idle");
		expect(entry.error).toBe("turn_failed:usage_limit");
		const refused = chatPaneActionEntry(
			identity,
			{ ...idle, lastTurnFailure: "usage_limit", handoffRefusal: "usage_unknown" },
			{ interrupt: vi.fn() },
		);
		expect(refused.error).toBe("turn_failed:usage_limit; handoff_refused:usage_unknown");
		// A session error is the stronger fact and wins.
		const failed = chatPaneActionEntry(
			identity,
			{ ...idle, phase: "error", error: "provider_failed", lastTurnFailure: "usage_limit" },
			{ interrupt: vi.fn() },
		);
		expect(failed.error).toBe("provider_failed");
	});

	it("offers handoff and per-account switches only while idle and unlocked", async () => {
		const handoff = vi.fn().mockResolvedValue(undefined);
		const toWork = vi.fn().mockResolvedValue(undefined);
		const handlers = {
			interrupt: vi.fn(),
			handoff,
			switchAccount: { "acc-work": toWork, "acc-spare": vi.fn() },
		};
		const entry = chatPaneActionEntry(identity, idle, handlers);
		expect(Object.keys(entry.actions)).toEqual([
			"handoff",
			"switch_account:acc-work",
			"switch_account:acc-spare",
		]);
		await entry.actions["switch_account:acc-work"]?.();
		expect(toWork).toHaveBeenCalledTimes(1);

		const busy = chatPaneActionEntry(
			identity,
			{ ...idle, activeTurn: { turnId: "turn-1" } },
			handlers,
		);
		expect(Object.keys(busy.actions)).toEqual(["interrupt"]);
		const locked = chatPaneActionEntry(identity, { ...idle, locked: true }, handlers);
		expect(locked.actions).toEqual({});
		const sending = chatPaneActionEntry(
			identity,
			{ ...idle, accountMovesLocked: true },
			handlers,
		);
		expect(sending.actions).toEqual({});
		const noTarget = chatPaneActionEntry(identity, idle, { interrupt: vi.fn() });
		expect(noTarget.actions).toEqual({});
	});

	it("omits conversation from the context until one exists", () => {
		const entry = chatPaneActionEntry(
			{ ...identity, conversationId: undefined },
			idle,
			{ interrupt: vi.fn() },
		);
		expect(entry.context).toBe("agent=agent-1 pane=agent:agent-1 session=interaction-1");
	});
});
