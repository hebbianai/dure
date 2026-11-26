import { Expand, LayoutGrid } from "lucide-react";
import { useMemo } from "react";
import { AgentRow } from "@/components/agents/AgentRow";
import { useIndexedAgent } from "@/components/agents/useAgentIndex";
import { useAgentRowFacts } from "@/components/agents/useAgentRowFacts";
import {
	useAgentAttentionPlacement,
	useAgentRevealSpaceNames,
	useAgentRevealTargets,
} from "@/components/agents/useNextUp";
import { useLocalDayTick } from "@/components/spaces/useNowTick";
import { Button } from "@/components/ui/button";
import { WorkList, WorkShellRow } from "@/components/work/WorkList";
import { useWorkShell } from "@/components/work/useWorkView";
import { WindowContentPainted } from "@/components/workspace/WindowContentPainted";
import { agentRowModel } from "@/lib/agents/agentRowModel";
import { revealAgent } from "@/lib/agents/nextUpNavigation";
import { t } from "@/lib/i18n";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useWorkViewStore } from "@/lib/work/workViewStore";
import { navigateToPanel } from "@/lib/workspace/dock/panelFocusHandoff";
import { agentSessionWindowTarget } from "@/lib/workspace/window/agentSessionWindowTarget";
import { openAgentSessionWindow } from "@/lib/workspace/window/windows";
import type { Agent } from "@/types";

/** The Work view in the main area, in front of the Spaces deck (which stays
 * mounted behind it). With the sidebar collapsed it carries the Work list
 * itself. Until the conversation view arrives, the selected agent shows as
 * its card with the ways to its live views. */
export function WorkMain() {
	const sidebarOpen = useWindowSidebarStore((state) => state.open);
	return (
		<div
			data-slot="work-main"
			className="pane-card-surface absolute inset-0 flex overflow-hidden rounded-[var(--glass-radius-pane)] bg-glass-pane"
		>
			{!sidebarOpen && (
				<WorkList className="w-72 shrink-0 border-r border-glass-hairline pt-1" />
			)}
			<WorkDetail />
			{/* While Work is in front, it is what this window exists to show. */}
			<WindowContentPainted />
		</div>
	);
}

function WorkDetail() {
	const selected = useWorkViewStore((state) => state.selected);
	return (
		<section
			data-slot="work-detail"
			aria-label={t("work.detail.label")}
			className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4"
		>
			{selected === null ? (
				<WorkDetailEmpty />
			) : selected.startsWith("pane:") ? (
				<WorkShellDetail key={selected} shellKey={selected} />
			) : (
				<WorkAgentDetail key={selected} agentId={selected} />
			)}
		</section>
	);
}

function WorkDetailEmpty() {
	return (
		<p className="m-auto max-w-72 text-center text-xs text-muted-foreground">
			{t("work.detail.empty")}
		</p>
	);
}

function WorkAgentDetail({ agentId }: { agentId: string }) {
	const agent = useIndexedAgent(agentId);
	return agent ? <WorkAgentCard agent={agent} /> : <WorkDetailEmpty />;
}

function WorkAgentCard({ agent }: { agent: Agent }) {
	const dayStart = useLocalDayTick();
	const agentIds = useMemo(() => [agent.id], [agent.id]);
	const target = useAgentRevealTargets(agentIds).get(agent.id);
	const spaceName = useAgentRevealSpaceNames(agentIds, "pane").get(agent.id);
	const placement = useAgentAttentionPlacement(agent.id, dayStart);
	const facts = useAgentRowFacts(agent.id, {
		...placement,
		...(agent.branch ? { branch: agent.branch } : {}),
		...(spaceName ? { spaceName } : {}),
	});
	if (!facts) return <WorkDetailEmpty />;
	// The large window takes over the pane it was opened for, so it gets the
	// pane's owner id when the agent has one.
	const paneOwnerId =
		target?.kind === "pane" ? `${target.desktopId}:${target.panelId}` : undefined;
	const openLargeWindow = agentSessionWindowTarget(agent)
		? () => void openAgentSessionWindow(agent.id, facts.title, paneOwnerId)
		: undefined;
	return (
		<div className="flex w-full max-w-xl flex-col gap-2">
			<AgentRow row={agentRowModel(facts)} variant="card" />
			<div className="flex flex-wrap items-center gap-1">
				{openLargeWindow && (
					<Button variant="ghost" size="xs" onClick={openLargeWindow}>
						<Expand />
						{t("work.detail.openLargeWindow")}
					</Button>
				)}
				<Button variant="ghost" size="xs" onClick={() => revealAgent(agent.id)}>
					<LayoutGrid />
					{t("work.detail.showInSpace")}
				</Button>
			</div>
		</div>
	);
}

function WorkShellDetail({ shellKey }: { shellKey: string }) {
	const shell = useWorkShell(shellKey);
	if (!shell) return <WorkDetailEmpty />;
	return (
		<div className="flex w-full max-w-xl flex-col gap-2">
			<WorkShellRow shell={shell} variant="card" />
			<div className="flex flex-wrap items-center gap-1">
				<Button
					variant="ghost"
					size="xs"
					onClick={() => navigateToPanel(shell.desktopId, shell.panelId)}
				>
					<LayoutGrid />
					{t("work.detail.showInSpace")}
				</Button>
			</div>
		</div>
	);
}
