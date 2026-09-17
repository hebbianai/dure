import type { SshCredentialClaimV1, SshHostConfig } from "@/types";

const OWNED_CREDENTIAL_ACCOUNT_V1 = /^ssh-[A-Za-z0-9_-]{32}$/;
const MAX_CREDENTIAL_HOST_ID_BYTES = 1_024;
const MAX_CREDENTIAL_GENERATION_BYTES = 128;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedClaimReference(
	value: unknown,
	maximumBytes: number,
): string | undefined {
	const parsed = nonEmptyString(value);
	return parsed && new TextEncoder().encode(parsed).length <= maximumBytes
		? parsed
		: undefined;
}

/** Parses the durable ownership proof once at the persistence boundary. */
export function parseSshCredentialClaimV1(
	value: unknown,
): SshCredentialClaimV1 | undefined {
	const candidate = record(value);
	if (candidate?.schemaVersion !== 1) return undefined;
	const id = nonEmptyString(candidate.id);
	const hostId = boundedClaimReference(
		candidate.hostId,
		MAX_CREDENTIAL_HOST_ID_BYTES,
	);
	const registrationGeneration = boundedClaimReference(
		candidate.registrationGeneration,
		MAX_CREDENTIAL_GENERATION_BYTES,
	);
	if (
		!id ||
		!OWNED_CREDENTIAL_ACCOUNT_V1.test(id) ||
		!hostId ||
		!registrationGeneration
	) {
		return undefined;
	}
	return { schemaVersion: 1, id, hostId, registrationGeneration };
}

export function sameSshCredentialClaim(
	left: SshCredentialClaimV1 | undefined,
	right: SshCredentialClaimV1 | undefined,
): boolean {
	return (
		left === right ||
		Boolean(
			left &&
				right &&
				left.id === right.id &&
				left.hostId === right.hostId &&
				left.registrationGeneration === right.registrationGeneration,
		)
	);
}

/** Returns a claim only when it owns this exact Host generation. */
export function sshHostCredentialClaim(
	host: SshHostConfig | undefined,
): SshCredentialClaimV1 | undefined {
	if (!host) return undefined;
	const claim = parseSshCredentialClaimV1(host.credential);
	const compatibilityId = nonEmptyString(host.secretId);
	return claim &&
		claim.hostId === host.id &&
		claim.registrationGeneration === host.registrationGeneration &&
		(!compatibilityId || compatibilityId === claim.id)
		? claim
		: undefined;
}

/** Resolves the one credential account used by runtime projections. */
export function sshHostSecretId(
	host: SshHostConfig | undefined,
): string | undefined {
	return sshHostCredentialClaim(host)?.id ?? nonEmptyString(host?.secretId);
}

/**
 * Canonicalizes a Host credential reference. Invalid claims remain usable as
 * legacy references, but never gain deletion authority.
 */
export function normalizeSshHostCredential(host: SshHostConfig): SshHostConfig {
	const claim = sshHostCredentialClaim(host);
	if (claim) {
		return {
			...host,
			credential: claim,
			secretId: claim.id,
		};
	}
	const candidateId = nonEmptyString(record(host.credential)?.id);
	return {
		...host,
		credential: undefined,
		secretId: nonEmptyString(host.secretId) ?? candidateId,
	};
}

/** Parses immutable ownership claims and rejects conflicting duplicate IDs. */
export function normalizeSshCredentialClaims(
	value: unknown,
): SshCredentialClaimV1[] {
	if (!Array.isArray(value)) return [];
	const claims = new Map<string, SshCredentialClaimV1>();
	const conflicts = new Set<string>();
	for (const entry of value) {
		const claim = parseSshCredentialClaimV1(entry);
		if (!claim || conflicts.has(claim.id)) continue;
		const existing = claims.get(claim.id);
		if (!existing) {
			claims.set(claim.id, claim);
			continue;
		}
		if (!sameSshCredentialClaim(existing, claim)) {
			claims.delete(claim.id);
			conflicts.add(claim.id);
		}
	}
	return [...claims.values()];
}
