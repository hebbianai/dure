import { describe, expect, it, vi } from "vitest";
import {
	ManagedCreateRejectedError,
	ManagedCreateRetrySameError,
	managedCreateInvokeOutcomeUnknown,
} from "@/lib/hmux/managed/managedCreateResolution";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { ManagedRuntimeRecoveryIncompleteError } from "../../../../cli/lib/managed-runtime-recovery.mjs";
import {
	managedRecoveryFailureCode,
	recordManagedRecoveryFailure,
} from "./managedRecoveryDiagnostics";

const operationFailure = {
	kind: "operation",
	disposition: "retry_same",
} as const;

describe("managed recovery failure code", () => {
	it.each([
		[
			"a retry_same create names its backend code",
			new ManagedCreateRetrySameError(
				"create_retryable",
				"session_checkout_store_busy",
				"store is busy during prepare_session_checkout",
			),
			"session_checkout_store_busy",
		],
		[
			"a lost create response",
			managedCreateInvokeOutcomeUnknown(new Error("ipc closed")),
			"managed_create_outcome_unknown",
		],
		[
			"a rejected create",
			new ManagedCreateRejectedError(
				"session_checkout_closing",
				"checkout claim admission is closed",
			),
			"session_checkout_closing",
		],
		[
			"a backend wake refusal",
			new DureBackendRequestError(
				"agent_runtime_transition_conflict",
				"conflict",
				operationFailure,
			),
			"agent_runtime_transition_conflict",
		],
		[
			"a busy wake source",
			new DureAgentRuntimeSourceActiveError(
				new DureBackendRequestError(
					"agent_runtime_source_busy",
					"busy",
					operationFailure,
				),
			),
			"agent_runtime_source_busy",
		],
		[
			"a wake that did not reach a stable runtime",
			new ManagedRuntimeRecoveryIncompleteError("wake", {
				state: "transitioning",
			}),
			"managed_runtime_recovery_wake_transitioning",
		],
		[
			"a coded message",
			new Error("recovering: backend authority is switching generations"),
			"recovering",
		],
		[
			"a closed checkout message",
			new Error("session_checkout_closing: checkout claim admission is closed"),
			"session_checkout_closing",
		],
		[
			"a bare code string",
			"managed_create_outcome_unknown",
			"managed_create_outcome_unknown",
		],
	])("keeps the code of %s", (_name, cause, code) => {
		expect(managedRecoveryFailureCode(cause)).toBe(code);
	});

	it.each([
		["prose", new Error("response lost")],
		["a capitalized message", new Error("Failed to fetch")],
		["a path", new Error("/Users/private/worktree: missing")],
		[
			"an invalid backend code",
			new DureBackendRequestError(
				"Bad Code",
				"backend failed",
				operationFailure,
			),
		],
		["an overlong token", new Error(`a${"b".repeat(128)}`)],
		["no value", undefined],
	])("never records free text from %s", (_name, cause) => {
		expect(managedRecoveryFailureCode(cause)).toBe("unclassified");
	});
});

describe("recording a failed managed recovery", () => {
	it("appends the stage, code and Agent", () => {
		const append = vi.fn().mockResolvedValue(undefined);
		recordManagedRecoveryFailure(
			"lineage_wake",
			"agent-1",
			new Error("recovering: switching"),
			append,
		);
		expect(append).toHaveBeenCalledExactlyOnceWith({
			stage: "lineage_wake",
			code: "recovering",
			agentId: "agent-1",
		});
	});

	it("omits an Agent ID that is not a domain ID", () => {
		const append = vi.fn().mockResolvedValue(undefined);
		recordManagedRecoveryFailure(
			"exact_resume",
			"agent with spaces",
			new Error("response lost"),
			append,
		);
		expect(append).toHaveBeenCalledExactlyOnceWith({
			stage: "exact_resume",
			code: "unclassified",
		});
	});

	it("never lets a journal failure escape", async () => {
		const rejected = vi
			.fn()
			.mockRejectedValue(new Error("journal unavailable"));
		const thrown = vi.fn(() => {
			throw new Error("ipc unavailable");
		});
		expect(() =>
			recordManagedRecoveryFailure("exact_resume", "agent-1", "x", rejected),
		).not.toThrow();
		expect(() =>
			recordManagedRecoveryFailure("exact_resume", "agent-1", "x", thrown),
		).not.toThrow();
		await Promise.resolve();
		expect(rejected).toHaveBeenCalledOnce();
	});
});
