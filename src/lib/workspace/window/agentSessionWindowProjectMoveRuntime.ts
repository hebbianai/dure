import { prepareAgentProjectMove } from "@/lib/agents/agentProjectMove";
import type { PreparedAgentProjectMove } from "@/lib/agents/agentProjectMoveTypes";
import type { AgentProjectMovePlan } from "@/lib/ipc/dureAgentProjectMove";
import type {
	AgentSessionProjectMoveCommand,
	AgentSessionProjectMoveResult,
} from "./agentSessionWindowProjectMoveCommand";

interface HeldProjectMove {
	readonly moveId: string;
	readonly prepared: PreparedAgentProjectMove;
	/** The plan this window last produced for the move: a preview, or the one
	 * the backend journal recovered. A later step may act only on it. */
	plan?: AgentProjectMovePlan;
}

/** Project moves a large window prepared, held by the window that owns the
 * source pane, one per Agent. Each preparation replaces the Agent's previous
 * one, so a large window that never finishes its dialog leaves nothing more
 * behind. The backend journal, not this holder, owns recovery: a step that
 * names a move this window no longer holds is refused without starting
 * anything, and the dialog prepares again from the journal. */
const heldMoves = new Map<string, HeldProjectMove>();

class HeldProjectMoveRefusal extends Error {
	readonly submitted = false;
	constructor(readonly code: string) {
		super(code);
	}
}

function heldMove(agentId: string, moveId: string): HeldProjectMove {
	const held = heldMoves.get(agentId);
	if (held?.moveId !== moveId)
		throw new HeldProjectMoveRefusal("client_project_move_preview_stale");
	return held;
}

/** Runs one step of a large window's project move dialog exactly as the
 * source pane's own dialog runs it, on the move this window prepared. */
export async function executeHeldAgentProjectMoveStep(
	command: AgentSessionProjectMoveCommand & { agentId: string },
): Promise<AgentSessionProjectMoveResult> {
	const { agentId } = command;
	switch (command.step) {
		case "prepare": {
			const prepared = await prepareAgentProjectMove(agentId);
			const held: HeldProjectMove = {
				moveId: crypto.randomUUID(),
				prepared,
				...(prepared.recoveredPlan ? { plan: prepared.recoveredPlan } : {}),
			};
			heldMoves.set(agentId, held);
			return {
				kind: "project_move_prepared",
				moveId: held.moveId,
				projects: prepared.projects,
				complete: prepared.complete,
				...(prepared.recoveredPlan
					? { recoveredPlan: prepared.recoveredPlan }
					: {}),
				...(prepared.recoveredStatus
					? { recoveredStatus: prepared.recoveredStatus }
					: {}),
			};
		}
		case "preview": {
			const held = heldMove(agentId, command.moveId);
			const plan = await held.prepared.preview(command.projectId);
			held.plan = plan;
			return { kind: "project_move_previewed", plan };
		}
		default: {
			const held = heldMove(agentId, command.moveId);
			const { plan } = held;
			if (plan?.operationId !== command.operationId)
				throw new HeldProjectMoveRefusal("client_project_move_preview_stale");
			if (command.step === "status")
				return {
					kind: "project_move_status",
					status: await held.prepared.status(plan),
				};
			if (command.step === "repair") await held.prepared.repair(plan);
			else await held.prepared.apply(plan);
			if (heldMoves.get(agentId) === held) heldMoves.delete(agentId);
			return { kind: "project_move_done" };
		}
	}
}
