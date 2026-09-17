import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	type LocalManagedBinding,
	type ManagedRecoveryIdentity,
	shortManagedRuntimeDigest,
} from "@/lib/sessions/managed/managedAgentRuntimeState";

const ROUTE_RECOVERY_OPERATION = /^recovery4_([0-9a-f]{16})_([0-9a-f]{64})$/;
const ROUTE_REVISION = /^sha256:([0-9a-f]{64})$/;

type RecoverySource = Pick<
	LocalManagedBinding,
	"workspaceId" | "sessionId" | "backendProfileId" | "stopFence"
>;

function recoveryProfileId(binding: RecoverySource): string {
	return binding.backendProfileId ?? "local";
}

function recoverySourceDigest(binding: RecoverySource): string {
	const generation = binding.stopFence
		? [
				binding.stopFence.runnerPrincipal,
				binding.stopFence.runnerInstance,
				binding.stopFence.channelEpoch,
				binding.stopFence.hostInstanceId,
				binding.stopFence.terminalEpoch,
			]
		: ["unfenced"];
	const sourceSeed = [
		"managed-recovery-route-v4",
		"replace_ai_provider_with_explicit_conversation",
		binding.workspaceId,
		binding.sessionId,
		recoveryProfileId(binding),
		...generation,
	].join("\0");
	return (
		shortManagedRuntimeDigest(sourceSeed) +
		shortManagedRuntimeDigest(`hmux-recovery-route\0${sourceSeed}`)
	);
}

/** Bind one exact Dure route revision to Hmux's existing opaque operation id.
 * Hmux persists the identifier without learning the caller-owned semantics. */
export function managedRecoveryRouteIdentity(
	binding: RecoverySource,
	authority: DureBackendRouteAuthorityV1,
): ManagedRecoveryIdentity {
	const revision = ROUTE_REVISION.exec(authority.revision)?.[1];
	if (!revision || authority.profileId !== recoveryProfileId(binding)) {
		throw new Error("managed recovery backend route does not match its source");
	}
	return {
		recoveryId: `recovery4_${recoverySourceDigest(binding)}_${revision}`,
	};
}

interface ManagedRecoveryRouteIdentity extends ManagedRecoveryIdentity {
	revision: string;
}

/** Parse only the route-bound v4 identity for this exact source/profile.
 * Legacy v3 identifiers intentionally remain uncommitted and fail closed after
 * a frontend restart. */
export function parseManagedRecoveryRouteIdentity(
	binding: RecoverySource,
	operationId: string,
): ManagedRecoveryRouteIdentity | undefined {
	const match = ROUTE_RECOVERY_OPERATION.exec(operationId);
	if (!match || match[1] !== recoverySourceDigest(binding)) return undefined;
	return {
		recoveryId: operationId,
		revision: `sha256:${match[2]}`,
	};
}

type ResolveSelectedRoute = typeof resolveSelectedDureBackendRouteAuthority;

/** Materialize a read-only candidate, then accept it only if the Hmux-journaled
 * commitment proves the exact profile and semantic route revision. No backend
 * effect is allowed before this function returns the exact authority. */
export async function resolveManagedRecoveryRouteAuthority(
	binding: RecoverySource,
	operationId: string,
	resolveSelectedRoute: ResolveSelectedRoute = resolveSelectedDureBackendRouteAuthority,
): Promise<DureBackendRouteAuthorityV1 | undefined> {
	const identity = parseManagedRecoveryRouteIdentity(binding, operationId);
	if (!identity) return undefined;
	const profileId = recoveryProfileId(binding);
	const candidate = await resolveSelectedRoute(profileId);
	return candidate.profileId === profileId &&
		candidate.revision === identity.revision
		? candidate
		: undefined;
}
