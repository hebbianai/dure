export {
	buildPendingQuestionAnswers,
	parsePendingPermissionPresentation,
	parsePendingQuestions,
	presentPendingAnswer,
} from "../../../../cli/lib/contracts/agent-pending-presentation.mjs";

/** The provider tool whose permission request is a plan-mode exit (Claude). */
const PLAN_APPROVAL_TOOLS = new Set(["ExitPlanMode"]);

export interface PendingPlanApproval {
	readonly plan: string | null;
	readonly planFilePath: string | null;
}

function nonEmptyText(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

/** A permission request that asks to leave plan mode and start working. The
 * plan text is shown when the provider put it in the request; a newer CLI
 * may only name the file it saved the plan to. */
export function parsePendingPlanApproval(
	payload: unknown,
): PendingPlanApproval | undefined {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return undefined;
	}
	const request = payload as Record<string, unknown>;
	if (typeof request.toolName !== "string" || !PLAN_APPROVAL_TOOLS.has(request.toolName)) {
		return undefined;
	}
	const input =
		typeof request.input === "object" && request.input !== null && !Array.isArray(request.input)
			? (request.input as Record<string, unknown>)
			: {};
	return {
		plan: nonEmptyText(input.plan),
		planFilePath: nonEmptyText(input.planFilePath) ?? nonEmptyText(input.filePath),
	};
}
