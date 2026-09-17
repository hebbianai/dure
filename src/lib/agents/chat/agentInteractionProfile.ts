import { hasOnlyKeys, asRecord as record } from "@/lib/payloadGuards";

const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** Persisted IDE projection of the backend-owned interaction choice. Runtime,
 * credential, and timeline fences are always re-read from the backend binding. */
export interface AgentStructuredInteractionProfileV1 {
	schemaVersion: 1;
	kind: "structured_protocol";
	backendProfileId: string;
	interactionSessionId: string;
}

export type AgentInteractionProfileV1 = AgentStructuredInteractionProfileV1;

export function normalizeAgentInteractionProfileV1(
	value: unknown,
): AgentInteractionProfileV1 | undefined {
	const candidate = record(value);
	return candidate &&
		hasOnlyKeys(candidate, [
			"schemaVersion",
			"kind",
			"backendProfileId",
			"interactionSessionId",
		]) &&
		candidate.schemaVersion === 1 &&
		candidate.kind === "structured_protocol" &&
		typeof candidate.backendProfileId === "string" &&
		DOMAIN_ID.test(candidate.backendProfileId) &&
		typeof candidate.interactionSessionId === "string" &&
		DOMAIN_ID.test(candidate.interactionSessionId)
		? {
				schemaVersion: 1,
				kind: "structured_protocol",
				backendProfileId: candidate.backendProfileId,
				interactionSessionId: candidate.interactionSessionId,
			}
		: undefined;
}
