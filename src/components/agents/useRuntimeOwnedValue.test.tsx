// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	useRuntimeOwnedRequest,
	useRuntimeOwnedValue,
} from "@/components/agents/useRuntimeOwnedValue";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import { agentFixture } from "@/test/agentFixtures";

describe("useRuntimeOwnedValue", () => {
	it("clears an old owner's value and rejects its late async write", () => {
		const hook = renderHook(
			({ ownerKey }) => useRuntimeOwnedValue<string>(ownerKey),
			{ initialProps: { ownerKey: "runtime-1" } },
		);
		const staleSetValue = hook.result.current[1];
		act(() => staleSetValue("first failure"));
		expect(hook.result.current[0]).toBe("first failure");

		hook.rerender({ ownerKey: "runtime-2" });
		expect(hook.result.current[0]).toBeUndefined();
		act(() => staleSetValue("late first failure"));
		expect(hook.result.current[0]).toBeUndefined();

		act(() => hook.result.current[1]("second failure"));
		expect(hook.result.current[0]).toBe("second failure");
	});

	it("does not revive a stale value when an owner key is reused", () => {
		const hook = renderHook(
			({ ownerKey }) => useRuntimeOwnedValue<string>(ownerKey),
			{ initialProps: { ownerKey: "runtime-1" } },
		);
		act(() => hook.result.current[1]("first failure"));

		hook.rerender({ ownerKey: "runtime-2" });
		hook.rerender({ ownerKey: "runtime-1" });

		expect(hook.result.current[0]).toBeUndefined();
	});

	it("does not let an old completion unlock a new owner's action", () => {
		const hook = renderHook(
			({ ownerKey }) => useRuntimeOwnedValue<boolean>(ownerKey),
			{ initialProps: { ownerKey: "runtime-1" } },
		);
		const finishOldAction = hook.result.current[1];
		act(() => finishOldAction(true));

		hook.rerender({ ownerKey: "runtime-2" });
		act(() => hook.result.current[1](true));
		act(() => finishOldAction(false));

		expect(hook.result.current[0]).toBe(true);
	});

	it("clears a structured failure when credentials change in one interaction", () => {
		const source = agentFixture({
			interactionProfile: {
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
			},
			executionProfile: {
				kind: "credential_reference",
				reference_id: "account-a",
				credential_generation: "credential-a-1",
			},
		});
		const replacement = {
			...source,
			executionProfile: {
				kind: "credential_reference" as const,
				reference_id: "account-b",
				credential_generation: "credential-b-2",
			},
		};
		const hook = renderHook(
			({ agent }) =>
				useRuntimeOwnedValue<string>(agentRuntimePresentationOwnerKey(agent)),
			{ initialProps: { agent: source } },
		);
		act(() => hook.result.current[1]("stale account failure"));

		hook.rerender({ agent: replacement });

		expect(hook.result.current[0]).toBeUndefined();
	});
});

describe("useRuntimeOwnedRequest", () => {
	it("accepts only the newest request for the same runtime owner", () => {
		const { result } = renderHook(() => useRuntimeOwnedRequest("runtime-a"));
		const firstIsCurrent = result.current();
		const secondIsCurrent = result.current();

		expect(firstIsCurrent()).toBe(false);
		expect(secondIsCurrent()).toBe(true);
	});

	it("invalidates a request when the runtime owner changes", () => {
		const { result, rerender } = renderHook(
			({ ownerKey }) => useRuntimeOwnedRequest(ownerKey),
			{ initialProps: { ownerKey: "runtime-a" } },
		);
		const firstIsCurrent = result.current();
		rerender({ ownerKey: "runtime-b" });

		expect(firstIsCurrent()).toBe(false);
		expect(result.current()()).toBe(true);
	});

	it("does not let a stale owner callback invalidate the new owner's request", () => {
		const { result, rerender } = renderHook(
			({ ownerKey }) => useRuntimeOwnedRequest(ownerKey),
			{ initialProps: { ownerKey: "runtime-a" } },
		);
		const beginForRuntimeA = result.current;
		rerender({ ownerKey: "runtime-b" });
		const runtimeBIsCurrent = result.current();
		const staleRuntimeAIsCurrent = beginForRuntimeA();

		expect(staleRuntimeAIsCurrent()).toBe(false);
		expect(runtimeBIsCurrent()).toBe(true);
	});
});
