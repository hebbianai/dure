import {
	sshCredentialClaimActivate,
	sshCredentialClaimReconcile,
	sshCredentialClaimRetire,
	sshCredentialClaimStage,
} from "@/lib/ipc";
import {
	normalizeSshCredentialClaims,
	parseSshCredentialClaimV1,
	sameSshCredentialClaim,
} from "@/lib/ssh/sshCredentialClaim";
import type { SshCredentialClaimV1 } from "@/types";

export interface SshCredentialCleanupReport {
	readonly deleted: readonly string[];
	readonly retained: readonly string[];
}

function canonicalClaims(
	claims: readonly SshCredentialClaimV1[],
): SshCredentialClaimV1[] {
	const canonical = normalizeSshCredentialClaims(claims);
	if (
		claims.some((claim) => {
			const parsed = parseSshCredentialClaimV1(claim);
			return (
				!parsed ||
				!canonical.some((candidate) =>
					sameSshCredentialClaim(candidate, parsed),
				)
			);
		})
	) {
		throw new Error("ssh_credential_claim_invalid");
	}
	return canonical;
}

async function transitionClaims(
	claims: readonly SshCredentialClaimV1[],
	transition: (claims: readonly SshCredentialClaimV1[]) => Promise<void>,
): Promise<void> {
	const canonical = canonicalClaims(claims);
	if (canonical.length > 0) await transition(canonical);
}

export function stageSshCredentialClaims(
	claims: readonly SshCredentialClaimV1[],
): Promise<void> {
	return transitionClaims(claims, sshCredentialClaimStage);
}

export function activateSshCredentialClaims(
	claims: readonly SshCredentialClaimV1[],
): Promise<void> {
	return transitionClaims(claims, sshCredentialClaimActivate);
}

export function retireSshCredentialClaims(
	claims: readonly SshCredentialClaimV1[],
): Promise<void> {
	return transitionClaims(claims, sshCredentialClaimRetire);
}

export async function reconcileSshCredentialClaims(
	liveClaims: readonly SshCredentialClaimV1[],
	referencedIds: readonly string[],
): Promise<SshCredentialCleanupReport> {
	const report = await sshCredentialClaimReconcile(
		canonicalClaims(liveClaims),
		[...new Set(referencedIds)],
	);
	for (const failure of report.failures) {
		console.error(`[ssh credential cleanup:${failure.id}]`, failure.error);
	}
	return { deleted: report.deleted, retained: report.retained };
}
