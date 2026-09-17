import type { ReactNode } from "react";
import {
	AgentContextMenu,
	type AgentForkPresenter,
} from "@/components/agents/AgentContextMenu";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { agentPanelSecondaryBarTone } from "@/lib/agents/agentPanelSurfaceTone";
import { t } from "@/lib/i18n";
import { openAgentPanel } from "@/lib/workspace/dock";
import { isMountedPaneOwned } from "@/lib/workspace/pane/paneOwnership";
import type { Agent } from "@/types";

/** Presents a fork in the exact mounted desktop that owns the source pane. */
export function presentForkInAgentPanelDesktop(
	source: { readonly desktopId: string | undefined; readonly panelId: string },
	forkedAgent: Agent,
): void {
	if (
		!source.desktopId ||
		!isMountedPaneOwned({
			desktopId: source.desktopId,
			panelId: source.panelId,
		}) ||
		!openAgentPanel(source.desktopId, forkedAgent)
	) {
		throw new Error(t("workspace.agentWindow.forkPresentationFailed"));
	}
}

/** Shared visual and context-menu authority for Agent work-surface toolbars. */
export function AgentPanelToolbarFrame({
	agent,
	children,
	hmux,
	presentFork,
}: {
	agent: Agent;
	children: ReactNode;
	hmux: boolean;
	presentFork: AgentForkPresenter;
}) {
	// 기본 모드 간소화(2026-08-31): fork는 멀티 에이전트 워크플로 — 우클릭
	// 메뉴와 네이티브 힌트 title이 함께 접힌다.
	// The hint stays a native title, the one exception to the shared tooltip:
	// on a container it would open beside the hints of the buttons it holds
	// (the browser shows only the innermost title), and the context-menu
	// trigger clones its props straight onto this element.
	const interfaceMode = useInterfaceMode();
	const bar = (
		<div
			className={`@container/agent-panel-toolbar flex min-h-8 shrink-0 flex-wrap items-center justify-end gap-x-0.5 border-b px-2 py-1 text-[13px] ${agentPanelSecondaryBarTone(hmux)}`}
			data-agent-panel-toolbar
			title={
				interfaceMode === "pro" ? t("panels.agent.forkSessionHint") : undefined
			}
		>
			{children}
		</div>
	);
	if (interfaceMode === "basic") return bar;
	return (
		<AgentContextMenu agent={agent} presentFork={presentFork}>
			{bar}
		</AgentContextMenu>
	);
}
