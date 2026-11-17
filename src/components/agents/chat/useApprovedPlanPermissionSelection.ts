import { useEffect, useMemo, useRef } from "react";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import { approvedPlanPermission } from "@/lib/agents/chat/planApprovalPermission";

/** Claude leaves plan mode for the rest of its process once a plan is
 * approved. Move the pane's selection to the mode Claude continues in, so
 * the picker and the next launch match the live process. The change goes
 * through the selection's own control; while the turn runs it waits as a
 * pending settings change like any other mid-turn edit. */
export function useApprovedPlanPermissionSelection(
	session: AgentChatSessionView,
	launch: AgentRuntimeLaunchSelectionView | undefined,
): void {
	const rows = session.page?.rows;
	const turnActive = session.activeTurn !== undefined;
	const approved = useMemo(
		() => (rows ? approvedPlanPermission(rows, { turnActive }) : null),
		[rows, turnActive],
	);
	const followed = useRef<string | null>(null);
	const ready =
		launch?.loaded === true &&
		launch.permissionMode === "plan" &&
		launch.pending === undefined &&
		!launch.switching;
	const switchSelection = launch?.switchSelection;
	const selectionRevision = launch?.selectionRevision;
	const conversationId = launch?.conversationId;
	useEffect(() => {
		if (!approved || !ready || !switchSelection) return;
		if (followed.current === approved.approvalItemId) return;
		followed.current = approved.approvalItemId;
		const { permissionMode } = approved;
		void switchSelection(
			(source) =>
				source.permissionMode === "plan"
					? { ...source, permissionMode }
					: source,
			{
				...(selectionRevision !== undefined
					? { expectedSourceRevision: selectionRevision }
					: {}),
				...(conversationId !== undefined
					? { expectedConversationId: conversationId }
					: {}),
			},
		);
	}, [approved, ready, switchSelection, selectionRevision, conversationId]);
}
