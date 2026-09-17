import { asRecord } from "@/lib/payloadGuards";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import type { SerializedPanelRef } from "@/lib/workspace/layout/layoutLifecycle";
import type { Agent } from "@/types";

/** Presentation discovery only; a session reference does not grant runtime authority. */
export function sessionIdForPane(
	{ component, params }: SerializedPanelRef,
	agents: readonly Pick<
		Agent,
		"id" | "interactionProfile" | "runtimeBinding" | "sessionId"
	>[],
): string | null {
	let sessionId: unknown;
	if (component === "agent") {
		const agentId = agentIdFromPaneParameters(params);
		const agent = agents.find((candidate) => candidate.id === agentId);
		sessionId =
			agent?.interactionProfile?.kind === "structured_protocol"
				? agent.interactionProfile.interactionSessionId
				: (agent?.runtimeBinding?.sessionId ?? agent?.sessionId);
	} else if (component === "terminal" || component === "ssh") {
		sessionId = params.sessionId ?? asRecord(params.binding)?.sessionId;
	}
	return typeof sessionId === "string" && sessionId ? sessionId : null;
}
