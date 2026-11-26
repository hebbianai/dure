import { useAgentConversationHistoryActionLease } from "@/components/agents/AgentConversationHistoryControl";
import { PanelStatus } from "@/components/common/PanelStatus";
import type { AgentPanelDockProps } from "@/components/panels/agentPanelContract";
import { NativeAgentPanel } from "@/components/panels/NativeAgentPanel";
import { StructuredAgentPanel } from "@/components/panels/StructuredAgentPanel";
import { useAgentPanelState } from "@/components/panels/useAgentPanelState";
import { PaneRehostBoundary } from "@/components/workspace/PaneRehostBoundary";
import { usePaneStatusCard } from "@/components/workspace/usePaneStatusCard";
import { t } from "@/lib/i18n";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";

/** Agent-pane mount attaches to backend-owned runtime state. Native panes use
 * Hmux directly; Chat panes project the next complete authoritative snapshot
 * when a durable transition finished while their view was disconnected.
 * Either kind shows its status card instead of its live view while the pane
 * is too small to read; this router owns that one size observation. */
export function AgentPanel(props: AgentPanelDockProps) {
	return (
		<PaneRehostBoundary paneId={props.api.id}>
			<AgentPanelContent {...props} />
		</PaneRehostBoundary>
	);
}

function AgentPanelContent(props: AgentPanelDockProps) {
	const agentId = agentIdFromPaneParameters(props.params);
	const controller = useAgentPanelState(agentId ?? "", props.api.id);
	const historyActionLease = useAgentConversationHistoryActionLease();
	const statusCard = usePaneStatusCard<HTMLDivElement>();
	const { agent } = controller;
	if (!agent) {
		return <PanelStatus>{t("common.unavailable")}</PanelStatus>;
	}
	return (
		<div ref={statusCard.ref} className="h-full min-h-0">
			{agent.interactionProfile?.kind === "structured_protocol" ? (
				<StructuredAgentPanel
					agent={agent}
					historyActionLease={historyActionLease}
					profile={agent.interactionProfile}
					panelProps={props}
					launchSelection={controller.launchSelection}
					statusCard={statusCard.shown}
					onRuntimeInvalidated={controller.onStructuredRuntimeInvalidated}
					switchCredential={(requestedAgentId, targetCredentialId) =>
						controller.switchAgentCredential(
							requestedAgentId,
							targetCredentialId,
							props.api.id,
						)
					}
					switchToNativeTerminal={
						controller.switchStructuredAgentToNativeTerminal
					}
				/>
			) : (
				<NativeAgentPanel
					agent={agent}
					historyActionLease={historyActionLease}
					backendManaged={controller.backendManaged}
					panelProps={props}
					launchSelection={controller.launchSelection}
					statusCard={statusCard.shown}
					switchCredential={(requestedAgentId, targetCredentialId) =>
						controller.switchAgentCredential(
							requestedAgentId,
							targetCredentialId,
							props.api.id,
						)
					}
					switchToStructuredChat={controller.switchAgentToStructuredChat}
				/>
			)}
		</div>
	);
}
