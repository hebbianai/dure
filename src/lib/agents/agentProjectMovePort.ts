import type { AgentProjectMovePort } from "./agentProjectMoveTypes";

/** A pane's project move: it prepares the move in the pane's own window. The
 * move logic loads only when the dialog first prepares. */
export function localAgentProjectMovePort(
	agentId: string,
): AgentProjectMovePort {
	return {
		prepare: async () =>
			(await import("./agentProjectMove")).prepareAgentProjectMove(agentId),
	};
}
