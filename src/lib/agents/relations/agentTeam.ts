// Which agents a manager's team line lists, and in which order. The relation
// owner says who is below whom; the needs-you order stays with Next up
// (oldest wait first), so this only picks from what the caller passes. It
// imports no store, i18n or React, so the phone's build can share it.
import type { AgentRelations } from "@/lib/agents/relations/agentRelations";

/** The agents `managerId` manages directly, in start order, then every agent
 * further down it that a person is needed for, in `needsYou`'s order. An
 * agent outside its subtree is never listed, and none is listed twice. */
export function agentTeamMembers(
	relations: AgentRelations,
	managerId: string,
	needsYou: readonly string[],
): readonly string[] {
	const direct = relations.managedBy(managerId);
	const deeper = needsYou.filter(
		(agentId) =>
			relations.managerOf(agentId) !== managerId &&
			relations.chain(agentId).includes(managerId),
	);
	return deeper.length === 0 ? direct : [...direct, ...deeper];
}
