import type { AgentProjectMovePlan } from "../../../cli/lib/contracts/agent-project-move.mjs";

export type AgentProjectMoveStatus =
	| "completed"
	| "repair_required"
	| "unconfirmed"
	| "not_submitted";

/** One prepared move: the destinations it offers, a plan the backend journal
 * recovered, and the steps that act on a reviewed plan. */
export interface PreparedAgentProjectMove {
	readonly projects: readonly {
		readonly id: string;
		readonly displayName: string;
	}[];
	readonly complete: boolean;
	readonly recoveredPlan?: AgentProjectMovePlan;
	readonly recoveredStatus?: "repair_required" | "transitioning";
	preview(projectId: string): Promise<AgentProjectMovePlan>;
	status(plan: AgentProjectMovePlan): Promise<AgentProjectMoveStatus>;
	repair(plan: AgentProjectMovePlan): Promise<void>;
	apply(plan: AgentProjectMovePlan): Promise<void>;
}

/** Where one Agent's project move runs. The pane prepares it in its own window
 * (`localAgentProjectMovePort`); the Agent's large window sends every step to
 * the window that owns the source pane (#624). The move dialog is the same on
 * both surfaces. */
export interface AgentProjectMovePort {
	prepare(): Promise<PreparedAgentProjectMove>;
}
