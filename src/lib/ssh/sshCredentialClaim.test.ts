import { describe, expect, it } from "vitest";
import {
	normalizeSshCredentialClaims,
	normalizeSshHostCredential,
	parseSshCredentialClaimV1,
	sshHostCredentialClaim,
	sshHostSecretId,
} from "@/lib/ssh/sshCredentialClaim";
import type { SshHostConfig } from "@/types";

const host: SshHostConfig = {
	id: "host-1",
	registrationGeneration: "generation-1",
	name: "Remote",
	host: "remote.example.test",
	port: 22,
	user: "dure",
	auth: "password",
};

const credentialOne = "ssh-11111111111111111111111111111111";

describe("SSH credential claims", () => {
	it("accepts ownership only for the exact Host generation", () => {
		const owned = {
			...host,
			credential: {
				schemaVersion: 1 as const,
				id: credentialOne,
				hostId: host.id,
				registrationGeneration: host.registrationGeneration ?? "",
			},
		};
		expect(sshHostCredentialClaim(owned)).toEqual(owned.credential);
		expect(sshHostSecretId(owned)).toBe(credentialOne);
		expect(normalizeSshHostCredential(owned).secretId).toBe(credentialOne);
		expect(
			sshHostCredentialClaim({
				...owned,
				registrationGeneration: "generation-2",
			}),
		).toBeUndefined();
	});

	it("demotes a mismatched claim to a non-deletable legacy reference", () => {
		const normalized = normalizeSshHostCredential({
			...host,
			credential: {
				schemaVersion: 1,
				id: credentialOne,
				hostId: host.id,
				registrationGeneration: "other-generation",
			},
		});

		expect(normalized.credential).toBeUndefined();
		expect(normalized.secretId).toBe(credentialOne);
	});

	it("preserves a newer legacy mirror when an old writer conflicts with a typed claim", () => {
		const normalized = normalizeSshHostCredential({
			...host,
			credential: {
				schemaVersion: 1,
				id: credentialOne,
				hostId: host.id,
				registrationGeneration: host.registrationGeneration ?? "",
			},
			secretId: "legacy-password-updated-by-v8",
		});

		expect(normalized.credential).toBeUndefined();
		expect(normalized.secretId).toBe("legacy-password-updated-by-v8");
		expect(sshHostCredentialClaim(normalized)).toBeUndefined();
		expect(sshHostSecretId(normalized)).toBe("legacy-password-updated-by-v8");
	});

	it("never grants deletion ownership to a legacy account wrapped as a claim", () => {
		const normalized = normalizeSshHostCredential({
			...host,
			credential: {
				schemaVersion: 1,
				id: "secret-old",
				hostId: host.id,
				registrationGeneration: host.registrationGeneration ?? "",
			},
		});

		expect(normalized.credential).toBeUndefined();
		expect(normalized.secretId).toBe("secret-old");
		expect(
			normalizeSshCredentialClaims([
				{
					schemaVersion: 1,
					id: "secret-old",
					hostId: host.id,
					registrationGeneration: host.registrationGeneration,
				},
			]),
		).toEqual([]);
	});

	it("rejects ownership references beyond the native boundary limit", () => {
		expect(
			parseSshCredentialClaimV1({
				schemaVersion: 1,
				id: credentialOne,
				hostId: host.id,
				registrationGeneration: "한".repeat(43),
			}),
		).toBeUndefined();
	});

	it("drops conflicting registry claims instead of choosing deletion authority", () => {
		expect(
			normalizeSshCredentialClaims([
				{
					schemaVersion: 1,
					id: credentialOne,
					hostId: "host-1",
					registrationGeneration: "generation-1",
				},
				{
					schemaVersion: 1,
					id: credentialOne,
					hostId: "host-2",
					registrationGeneration: "generation-2",
				},
			]),
		).toEqual([]);
	});
});
