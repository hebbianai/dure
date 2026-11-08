import {
	type AgentCanonicalSpawnV1,
	sameAgentCanonicalSpawn,
} from "@/lib/agents/agentCanonicalSpawn";
import type { Agent } from "@/types";
import type { CanonicalAgentStopReceiptV1 } from "../../../cli/lib/contracts/agent-dispatch-stop.mjs";

export type { CanonicalAgentStopReceiptV1 } from "../../../cli/lib/contracts/agent-dispatch-stop.mjs";
export {
	canonicalAgentStopApplyRevisionV1,
	parseCanonicalAgentStopResultV1,
	projectCanonicalAgentStopV1,
} from "../../../cli/lib/contracts/agent-dispatch-stop.mjs";

/** CAS predicate for presentation cleanup after a durable stop receipt. */
export function canonicalAgentStopAppliesToAgentV1(
	receipt: CanonicalAgentStopReceiptV1,
	provenance: AgentCanonicalSpawnV1,
	agent: Agent,
): boolean {
	return (
		receipt.agentId === agent.id &&
		receipt.spawnOperationId === provenance.operationId &&
		sameAgentCanonicalSpawn(agent.canonicalSpawn, provenance)
	);
}
