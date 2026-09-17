import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sshCredentialClaimActivate: vi.fn(),
	sshCredentialClaimReconcile: vi.fn(),
	sshCredentialClaimRetire: vi.fn(),
	sshCredentialClaimStage: vi.fn(),
}));

vi.mock("@/lib/ipc", () => mocks);

import {
	reconcileSshCredentialClaims,
	stageSshCredentialClaims,
} from "@/lib/ssh/sshCredentialRegistry";
import type { SshCredentialClaimV1 } from "@/types";

const claim: SshCredentialClaimV1 = {
	schemaVersion: 1,
	id: `ssh-${"a".repeat(32)}`,
	hostId: "host-1",
	registrationGeneration: "generation-1",
};

describe("SSH credential registry adapter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.sshCredentialClaimStage.mockResolvedValue(undefined);
		mocks.sshCredentialClaimReconcile.mockResolvedValue({
			deleted: [],
			retained: [],
			failures: [],
		});
	});

	it("passes one canonical claim to the native authority", async () => {
		await stageSshCredentialClaims([claim, claim]);

		expect(mocks.sshCredentialClaimStage).toHaveBeenCalledWith([claim]);
	});

	it("rejects an invalid producer claim instead of silently dropping it", async () => {
		await expect(
			stageSshCredentialClaims([
				{ ...claim, registrationGeneration: "한".repeat(43) },
			]),
		).rejects.toThrow("ssh_credential_claim_invalid");
		expect(mocks.sshCredentialClaimStage).not.toHaveBeenCalled();
	});

	it("rejects conflicting ownership before native reconciliation", async () => {
		await expect(
			reconcileSshCredentialClaims(
				[
					claim,
					{ ...claim, registrationGeneration: "generation-2" },
				],
				[],
			),
		).rejects.toThrow("ssh_credential_claim_invalid");
		expect(mocks.sshCredentialClaimReconcile).not.toHaveBeenCalled();
	});
});
