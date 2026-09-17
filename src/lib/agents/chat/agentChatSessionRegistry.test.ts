import { describe, expect, it, vi } from "vitest";
import { createAgentChatSessionRegistry } from "@/lib/agents/chat/agentChatSessionRegistry";

describe("agent chat session registry", () => {
	it("shares one live controller and detaches after the last pane grace period", () => {
		const controller = { start: vi.fn(), stop: vi.fn() };
		let release: (() => void) | undefined;
		const registry = createAgentChatSessionRegistry({
			create: () => controller,
			setTimer: (callback) => {
				release = callback;
				return 1;
			},
			clearTimer: vi.fn(),
		});
		const input = {
			agentId: "agent-1",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		};
		const first = registry.acquire(input);
		const second = registry.acquire(input);
		expect(first.controller).toBe(second.controller);
		expect(controller.start).toHaveBeenCalledTimes(1);
		first.release();
		expect(release).toBeUndefined();
		second.release();
		expect(release).toBeTypeOf("function");
		release?.();
		expect(controller.stop).toHaveBeenCalledTimes(1);
	});

	it("rejects another agent claiming the same durable interaction", () => {
		const registry = createAgentChatSessionRegistry({
			create: () => ({ start() {}, stop() {} }),
		});
		registry.acquire({
			agentId: "agent-1",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		});
		expect(() =>
			registry.acquire({
				agentId: "agent-2",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
			}),
		).toThrow("agent_chat_registry_identity_conflict");
	});
});
