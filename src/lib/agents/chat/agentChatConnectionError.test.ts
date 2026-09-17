import { describe, expect, it } from "vitest";
import {
	agentChatErrorMessage,
	shouldReconnectAgentChat,
} from "@/lib/agents/chat/agentChatConnectionError";
import {
	DureBackendRequestError,
	type DureRequestFailureV1,
} from "@/lib/ipc/dureBackend";

function backendError(failure: DureRequestFailureV1): DureBackendRequestError {
	return new DureBackendRequestError(
		"backend_failed",
		"backend failed",
		failure,
	);
}

describe("agentChatConnectionError", () => {
	it.each([
		{ kind: "transport" } as const,
		{ kind: "authority_changed" } as const,
		{ kind: "operation", disposition: "unassigned" } as const,
		{ kind: "operation", disposition: "stale_generation" } as const,
		{ kind: "operation", disposition: "retry_same" } as const,
	])("reconnects a replaceable $kind failure", (failure) => {
		expect(shouldReconnectAgentChat(backendError(failure))).toBe(true);
	});

	it.each([
		{ kind: "contract" } as const,
		{ kind: "operation", disposition: "terminal" } as const,
	])("stops on a terminal $kind failure", (failure) => {
		expect(shouldReconnectAgentChat(backendError(failure))).toBe(false);
	});

	it("retries an untyped connection failure", () => {
		expect(shouldReconnectAgentChat(new Error("disconnected"))).toBe(true);
	});

	it("preserves the reported error text", () => {
		expect(agentChatErrorMessage(new Error("disconnected"))).toBe(
			"disconnected",
		);
		expect(agentChatErrorMessage("backend_failed")).toBe("backend_failed");
	});
});
