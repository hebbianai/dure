import type {
	AgentProjectMovePort,
	AgentProjectMoveStatus,
	PreparedAgentProjectMove,
} from "@/lib/agents/agentProjectMoveTypes";
import { nonEmptyString } from "@/lib/payloadGuards";
import {
	type AgentProjectMovePlan,
	isAgentProjectMovePlan,
} from "../../../../cli/lib/contracts/agent-project-move.mjs";

const PLAN_STEPS = ["status", "repair", "apply"] as const;
type AgentSessionProjectMovePlanStep = (typeof PLAN_STEPS)[number];
const STATUSES: readonly AgentProjectMoveStatus[] = [
	"completed",
	"repair_required",
	"unconfirmed",
	"not_submitted",
];
const RECEIPT_INVALID =
	"The project move receipt is invalid; the outcome is uncertain.";

/** The project move dialog's steps, executed where the source pane owns the
 * runtime. The source window holds the move it prepared: a later step names
 * that move by `moveId` and the plan it reviewed by `operationId`, so the
 * source never acts on a plan copy sent back to it. */
export type AgentSessionProjectMoveCommand =
	| { action: "project_move"; step: "prepare" }
	| {
			action: "project_move";
			step: "preview";
			moveId: string;
			projectId: string;
	  }
	| {
			action: "project_move";
			step: AgentSessionProjectMovePlanStep;
			moveId: string;
			operationId: string;
	  };

export type AgentSessionProjectMoveResult =
	| ({
			kind: "project_move_prepared";
			moveId: string;
	  } & Pick<
			PreparedAgentProjectMove,
			"projects" | "complete" | "recoveredPlan" | "recoveredStatus"
	  >)
	| { kind: "project_move_previewed"; plan: AgentProjectMovePlan }
	| { kind: "project_move_status"; status: AgentProjectMoveStatus }
	| { kind: "project_move_done" };

function boundedString(value: unknown, maximumLength = 512): value is string {
	return nonEmptyString(value) && value.length <= maximumLength;
}

/** Whether an untrusted bridge payload is a well-formed project move step. */
export function agentSessionProjectMoveStepValid(
	payload: Record<string, unknown>,
): boolean {
	if (payload.step === "prepare") return true;
	if (!boundedString(payload.moveId, 128)) return false;
	if (payload.step === "preview") return boundedString(payload.projectId);
	return (
		PLAN_STEPS.includes(payload.step as AgentSessionProjectMovePlanStep) &&
		boundedString(payload.operationId)
	);
}

/** Only the fields a project move step defines; nothing else the sender put
 * on the payload reaches the source window's executor. */
export function agentSessionProjectMoveStep(
	command: AgentSessionProjectMoveCommand,
): AgentSessionProjectMoveCommand {
	switch (command.step) {
		case "prepare":
			return { action: "project_move", step: "prepare" };
		case "preview":
			return {
				action: "project_move",
				step: "preview",
				moveId: command.moveId,
				projectId: command.projectId,
			};
		default:
			return {
				action: "project_move",
				step: command.step,
				moveId: command.moveId,
				operationId: command.operationId,
			};
	}
}

function receipt<Kind extends AgentSessionProjectMoveResult["kind"]>(
	result: { readonly kind: string },
	kind: Kind,
	valid: (
		receipt: Extract<AgentSessionProjectMoveResult, { kind: Kind }>,
	) => boolean,
): Extract<AgentSessionProjectMoveResult, { kind: Kind }> {
	const candidate = result as Extract<
		AgentSessionProjectMoveResult,
		{ kind: Kind }
	>;
	if (result.kind !== kind || !valid(candidate))
		throw new Error(RECEIPT_INVALID);
	return candidate;
}

/** A plan the project move contract accepts for this Agent, into the project
 * the preview asked for or, for a recovered plan, the one it names. */
function planFor(
	plan: unknown,
	agentId: string,
	projectId?: string,
): plan is AgentProjectMovePlan {
	const targetProjectId =
		projectId ??
		(plan as Partial<AgentProjectMovePlan> | undefined)?.workspaceMove
			?.targetProject?.projectId;
	return (
		typeof targetProjectId === "string" &&
		isAgentProjectMovePlan(plan, agentId, targetProjectId)
	);
}

function preparedReceiptValid(
	prepared: Extract<
		AgentSessionProjectMoveResult,
		{ kind: "project_move_prepared" }
	>,
	agentId: string,
): boolean {
	return (
		boundedString(prepared.moveId, 128) &&
		typeof prepared.complete === "boolean" &&
		Array.isArray(prepared.projects) &&
		prepared.projects.every(
			(project) =>
				boundedString(project?.id) && typeof project.displayName === "string",
		) &&
		(prepared.recoveredPlan === undefined ||
			planFor(prepared.recoveredPlan, agentId)) &&
		(prepared.recoveredStatus === undefined ||
			prepared.recoveredStatus === "repair_required" ||
			prepared.recoveredStatus === "transitioning")
	);
}

/** A large window's project move. `send` delivers each step to the window that
 * owns the source pane, which runs it on the move it prepared; this window
 * keeps only the dialog and follows the durable Agent the source commits. */
export function agentSessionProjectMovePort(
	agentId: string,
	send: (
		command: AgentSessionProjectMoveCommand,
	) => Promise<{ readonly kind: string }>,
): AgentProjectMovePort {
	return {
		prepare: async () => {
			const prepared = receipt(
				await send({ action: "project_move", step: "prepare" }),
				"project_move_prepared",
				(candidate) => preparedReceiptValid(candidate, agentId),
			);
			const { moveId } = prepared;
			const planStep = (
				step: AgentSessionProjectMovePlanStep,
				plan: AgentProjectMovePlan,
			) =>
				send({
					action: "project_move",
					step,
					moveId,
					operationId: plan.operationId,
				});
			return {
				projects: prepared.projects,
				complete: prepared.complete,
				...(prepared.recoveredPlan
					? { recoveredPlan: prepared.recoveredPlan }
					: {}),
				...(prepared.recoveredStatus
					? { recoveredStatus: prepared.recoveredStatus }
					: {}),
				preview: async (projectId) =>
					receipt(
						await send({
							action: "project_move",
							step: "preview",
							moveId,
							projectId,
						}),
						"project_move_previewed",
						(candidate) => planFor(candidate.plan, agentId, projectId),
					).plan,
				status: async (plan) =>
					receipt(
						await planStep("status", plan),
						"project_move_status",
						(candidate) => STATUSES.includes(candidate.status),
					).status,
				repair: async (plan) => {
					receipt(
						await planStep("repair", plan),
						"project_move_done",
						() => true,
					);
				},
				apply: async (plan) => {
					receipt(
						await planStep("apply", plan),
						"project_move_done",
						() => true,
					);
				},
			};
		},
	};
}
