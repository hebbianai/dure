import type { AgentTimelineRowV1 } from "@/lib/agents/chat/agentConversationContract";
import { parsePendingPlanApproval } from "@/lib/agents/chat/agentPendingPresentation";
import {
	type DureProviderPermissionModeV1,
	isProviderPermissionMode,
} from "@/lib/ipc/dureAgentRuntime";

/** Claude leaves plan mode for the mode it had before plan mode. A session
 * Dure launched in plan mode had none, so Claude continues in `default`. */
const POST_PLAN_FALLBACK: DureProviderPermissionModeV1 = "default";

export interface ApprovedPlanPermission {
	/** The approval's timeline item: one approval moves the selection once. */
	readonly approvalItemId: string;
	readonly permissionMode: DureProviderPermissionModeV1;
}

function isAllowAnswer(answer: unknown): boolean {
	return (
		typeof answer === "object" &&
		answer !== null &&
		(answer as Record<string, unknown>).decision === "allow"
	);
}

/** Dure's mode from Claude's `provider_permission_mode` evidence; null when
 * Claude reported a mode Dure has no selection for. */
function reportedPermissionMode(
	value: unknown,
): DureProviderPermissionModeV1 | null {
	if (typeof value !== "object" || value === null) return null;
	const mode = (value as Record<string, unknown>).permissionMode;
	return isProviderPermissionMode(mode) ? mode : null;
}

/** The permission mode a plan-mode Claude session continues in after its
 * newest plan was approved, or null when there is nothing to follow: no
 * approval, "Keep planning", or Claude still reports plan mode.
 *
 * Only the running launch counts, so rows before its newest session init are
 * ignored. Claude reports the mode it switched to; until that report arrives
 * an approval waits while its turn runs, and a turn that ends without one
 * uses the mode Claude restores for a session launched in plan mode. */
export function approvedPlanPermission(
	rows: readonly AgentTimelineRowV1[],
	{ turnActive }: { turnActive: boolean },
): ApprovedPlanPermission | null {
	let reported: DureProviderPermissionModeV1 | null | undefined;
	let approval: { itemId: string; allowed: boolean } | undefined;
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const item = rows[index]?.item;
		if (!item) continue;
		const body = item.body;
		if (body.type === "provider_evidence") {
			if (body.kind === "provider_session_initialized") break;
			if (body.kind === "provider_permission_mode" && reported === undefined) {
				reported = reportedPermissionMode(body.value);
			}
			continue;
		}
		if (
			approval === undefined &&
			body.type === "pending_answer" &&
			body.request.request.kind === "permission" &&
			parsePendingPlanApproval(body.request.request.payload)
		) {
			approval = { itemId: item.itemId, allowed: isAllowAnswer(body.answer) };
		}
	}
	if (!approval?.allowed || reported === "plan") return null;
	if (reported === undefined && turnActive) return null;
	return {
		approvalItemId: approval.itemId,
		permissionMode: reported ?? POST_PLAN_FALLBACK,
	};
}
