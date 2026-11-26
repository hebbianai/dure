import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Expand } from "lucide-react";
import type { ReactNode } from "react";
import { AgentRow } from "@/components/agents/AgentRow";
import {
	type AgentRowPlacement,
	useAgentRowFacts,
} from "@/components/agents/useAgentRowFacts";
import { useAgentAttentionPlacement } from "@/components/agents/useNextUp";
import { Button } from "@/components/ui/button";
import { useAgentLargeViewSource } from "@/components/workspace/AgentLargeViewSourceProxy";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import { agentRowModel } from "@/lib/agents/agentRowModel";
import { t } from "@/lib/i18n";
import { agentSessionWindowTarget } from "@/lib/workspace/window/agentSessionWindowTarget";
import { openAgentSessionWindow } from "@/lib/workspace/window/windows";
import type { Agent } from "@/types";

/** Where the card's agent stands. A card stands in for its pane, so it
 * reports the agent exactly as Next up does: why a person is needed, or a
 * result nobody has looked at yet (focusing the pane clears it). Otherwise
 * it shows the agent's display state alone. */
function useStatusCardPlacement(agent: Agent): AgentRowPlacement {
	return {
		...useAgentAttentionPlacement(agent.id),
		...(agent.branch ? { branch: agent.branch } : {}),
	};
}

/** What an agent pane too small to read shows instead of its terminal or
 * conversation: the agent's row, a way to its large window, and how to get
 * the live view back. The pane keeps its runtime, hooks and recovery; only
 * the live presentation is gone, so nothing here reads transcripts, leases a
 * conversation or runs a timer. `children` are the pane's own hidden
 * controls (the pane menu's history and delegate entries open them). */
export function AgentStatusCard({
	agent,
	paneId,
	view,
	children,
}: {
	agent: Agent;
	paneId: string;
	/** What making the pane larger brings back. */
	view: "terminal" | "conversation";
	children?: ReactNode;
}) {
	const facts = useAgentRowFacts(agent.id, useStatusCardPlacement(agent));
	const desktopId = useWorkspaceRuntimeDesktopId();
	const largeView = useAgentLargeViewSource(
		{ agentId: agent.id, sourceWindowLabel: getCurrentWebviewWindow().label },
		paneId,
	);
	const openLargeWindow = agentSessionWindowTarget(agent)
		? () =>
				void openAgentSessionWindow(
					agent.id,
					facts?.title,
					desktopId ? `${desktopId}:${paneId}` : undefined,
				)
		: undefined;
	return (
		<div
			data-slot="agent-status-card"
			className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2"
		>
			{facts && (
				<AgentRow
					row={agentRowModel(facts)}
					variant="card"
					onSelect={openLargeWindow}
				/>
			)}
			<div className="flex flex-col items-start gap-1 px-1">
				{openLargeWindow && (
					<Button variant="ghost" size="xs" onClick={openLargeWindow}>
						<Expand />
						{largeView
							? t("terminal.largeView.bringToFront")
							: t("terminal.largeView.openNotice")}
					</Button>
				)}
				<p className="px-2 text-meta leading-4 text-muted-foreground">
					{view === "terminal"
						? t("workspace.statusCard.enlargeForTerminal")
						: t("workspace.statusCard.enlargeForConversation")}
				</p>
			</div>
			{children && (
				<div className="flex flex-wrap items-center gap-1 px-1 empty:hidden">
					{children}
				</div>
			)}
		</div>
	);
}
