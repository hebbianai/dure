import {
	isDureBackendProfileIdV1,
	isDureDomainIdV1,
} from "@/lib/ipc/dureProtocolIdentity";
import { hasOnlyKeys, asRecord as record } from "@/lib/payloadGuards";

/** Client projection of the canonical spawn receipt that created an Agent. */
export interface AgentCanonicalSpawnV1 {
	readonly schemaVersion: 1;
	readonly backendProfileId: string;
	readonly operationId: string;
}

export function parseAgentCanonicalSpawnV1(
	value: unknown,
): AgentCanonicalSpawnV1 | undefined {
	const candidate = record(value);
	return candidate &&
		hasOnlyKeys(candidate, [
			"schemaVersion",
			"backendProfileId",
			"operationId",
		]) &&
		candidate.schemaVersion === 1 &&
		isDureBackendProfileIdV1(candidate.backendProfileId) &&
		isDureDomainIdV1(candidate.operationId)
		? {
				schemaVersion: 1,
				backendProfileId: candidate.backendProfileId,
				operationId: candidate.operationId,
			}
		: undefined;
}

export function sameAgentCanonicalSpawn(
	left: AgentCanonicalSpawnV1 | undefined,
	right: AgentCanonicalSpawnV1 | undefined,
): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.backendProfileId === right.backendProfileId &&
		left.operationId === right.operationId
	);
}
