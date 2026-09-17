import { describe, expect, it } from "vitest";
import {
	ManagedCredentialReferenceChangedError,
	ManagedCredentialReferenceError,
	ManagedRecoveryRefusedError,
} from "@/lib/sessions/managed/managedAgentRuntimeErrors";

describe("managed agent runtime errors", () => {
	it("keeps credential reference failures machine-readable", () => {
		expect(new ManagedCredentialReferenceError("account-a")).toMatchObject({
			code: "credential_reference_unavailable",
			message: "credential reference is unavailable: account-a",
		});
		expect(new ManagedCredentialReferenceChangedError("account-b")).toMatchObject({
			code: "credential_reference_changed",
			message: "credential reference changed during preflight: account-b",
		});
	});

	it("preserves refusal diagnostics without duplicating the code", () => {
		const receipt = { outcome: "refused" } as never;
		expect(
			new ManagedRecoveryRefusedError("conversation_identity_unverified", {
				detail: "project directory is unavailable",
				receipt,
			}),
		).toMatchObject({
			code: "conversation_identity_unverified",
			message:
				"managed Hmux recovery was refused: project directory is unavailable",
			receipt,
		});
		expect(
			new ManagedRecoveryRefusedError("recovery_failed").message,
		).toBe("managed Hmux recovery was refused: recovery_failed");
	});
});
