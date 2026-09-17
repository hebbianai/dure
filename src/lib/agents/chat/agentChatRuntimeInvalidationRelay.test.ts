import { describe, expect, it, vi } from "vitest";
import type { StructuredAgentRuntimeProjectionGenerationV1 } from "@/lib/agents/agentRuntimeProjectionRecovery";
import { AgentChatRuntimeInvalidationRelay } from "@/lib/agents/chat/agentChatRuntimeInvalidationRelay";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

function generation(
	runtimeGeneration: string,
): StructuredAgentRuntimeProjectionGenerationV1 {
	return {
		routeAuthority: testDureBackendRouteAuthority("backend", "one"),
		bindingRevision: runtimeGeneration === "runtime-1" ? 1 : 2,
		runtimeGeneration,
		providerEpoch: runtimeGeneration.replace("runtime", "provider"),
	};
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("AgentChatRuntimeInvalidationRelay", () => {
	it("delivers a pending generation to a late subscriber until acknowledged", async () => {
		const relay = new AgentChatRuntimeInvalidationRelay();
		const observed = generation("runtime-1");
		const listener = vi.fn(() => true);

		relay.observe(observed);
		relay.subscribe(listener);
		await settle();

		expect(listener).toHaveBeenCalledOnce();
		expect(listener).toHaveBeenCalledWith(observed);
		const later = vi.fn(() => true);
		relay.subscribe(later);
		expect(later).not.toHaveBeenCalled();
	});

	it("retains rejected delivery and retries it on the next observation", async () => {
		const relay = new AgentChatRuntimeInvalidationRelay();
		const listener = vi
			.fn()
			.mockRejectedValueOnce(new Error("view detached"))
			.mockResolvedValueOnce(true);
		relay.subscribe(listener);

		const observed = generation("runtime-1");
		relay.observe(observed);
		await settle();
		relay.observe(observed);
		await settle();

		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("only lets an acknowledgement clear its exact generation", async () => {
		const relay = new AgentChatRuntimeInvalidationRelay();
		let acknowledgeFirst: ((acknowledged: boolean) => void) | undefined;
		const listener = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<boolean>((resolve) => {
						acknowledgeFirst = resolve;
					}),
			)
			.mockResolvedValue(false);
		relay.subscribe(listener);

		relay.observe(generation("runtime-1"));
		relay.observe(generation("runtime-2"));
		acknowledgeFirst?.(true);
		await settle();

		const late = vi.fn(() => true);
		relay.subscribe(late);
		expect(late).toHaveBeenCalledWith(generation("runtime-2"));
	});

	it("re-emits the observed generation when runtime recovery invalidates it", async () => {
		const relay = new AgentChatRuntimeInvalidationRelay();
		const listener = vi.fn(() => true);
		relay.subscribe(listener);
		relay.observe(generation("runtime-1"));
		await settle();

		relay.invalidate();

		expect(listener).toHaveBeenCalledTimes(2);
	});
});
