import type { Agent } from "@/types";

export type LegacyAgentWriterTarget<T extends Agent = Agent> = T & {
	readonly canonicalSpawn?: undefined;
};

const CANONICAL_AGENT_LEGACY_WRITER_REFUSED =
	"canonical_agent_legacy_writer_refused";

export class CanonicalAgentLegacyWriterRefusedError extends Error {
	readonly code = CANONICAL_AGENT_LEGACY_WRITER_REFUSED;

	constructor(readonly agentId: string) {
		super(`canonical Agent ${agentId} must use dispatch.stop`);
		this.name = "CanonicalAgentLegacyWriterRefusedError";
	}
}

/** Only Agents without backend spawn provenance belong to legacy writers. */
export function isLegacyAgentWriterTarget(
	agent: Agent | undefined,
): agent is LegacyAgentWriterTarget {
	return agent !== undefined && agent.canonicalSpawn === undefined;
}

export function requireLegacyAgentWriterTarget<T extends Agent>(
	agent: T,
): LegacyAgentWriterTarget<T> {
	if (!isLegacyAgentWriterTarget(agent)) {
		throw new CanonicalAgentLegacyWriterRefusedError(agent.id);
	}
	return agent;
}
