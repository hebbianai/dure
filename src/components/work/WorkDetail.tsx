import {
	ChevronLeft,
	ChevronRight,
	Expand,
	LayoutGrid,
	Pin,
	PinOff,
} from "lucide-react";
import { useMemo } from "react";
import { AgentRow } from "@/components/agents/AgentRow";
import {
	useAgentRegistryHydrated,
	useIndexedAgent,
} from "@/components/agents/useAgentIndex";
import { useAgentRelations } from "@/components/agents/useAgentRelations";
import { useAgentRowFacts } from "@/components/agents/useAgentRowFacts";
import {
	useAgentAttentionPlacement,
	useAgentRevealSpaceNames,
	useAgentRevealTargets,
} from "@/components/agents/useNextUp";
import { Button } from "@/components/ui/button";
import { PaneLabel } from "@/components/ui/pane-line";
import { IconButton } from "@/components/ui/icon-button";
import { WorkAlsoManagedBy, WorkBreadcrumb } from "@/components/work/WorkBreadcrumb";
import { WorkConversation } from "@/components/work/WorkConversation";
import { WorkManagedList } from "@/components/work/WorkManagedList";
import {
	useWorkShell,
	useWorkShellRowFacts,
	type WorkShellEntry,
} from "@/components/work/useWorkView";
import { agentRowModel } from "@/lib/agents/agentRowModel";
import { isShellRowKey } from "@/lib/agents/relations/shellRelationNodes";
import { revealAgent } from "@/lib/agents/nextUpNavigation";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { WorkDetailColumn as WorkDetailColumnPlace } from "@/lib/work/workViewState";
import { useWorkViewStore } from "@/lib/work/workViewStore";
import { navigateToPanel } from "@/lib/workspace/dock/panelFocusHandoff";
import { agentSessionWindowTarget } from "@/lib/workspace/window/agentSessionWindowTarget";
import { openAgentSessionWindow } from "@/lib/workspace/window/windows";
import type { Agent } from "@/types";

/** One detail column: an agent with the agents above it, the other agents
 * that manage it, the agents it manages and its conversation with a
 * composer, each part below the header under a hairline and its own label.
 * Every column is this same view, the selection's and each pinned one's.
 * Selecting any agent in it drills in by selecting that agent. */
export function WorkDetailColumn({
	column,
	alone,
	dayStart,
}: {
	column: WorkDetailColumnPlace;
	/** The only column shown: it needs no mark for being selected. */
	alone: boolean;
	/** Start of the local day: the Work view's result window. */
	dayStart: number;
}) {
	const marked = column.selected && !alone;
	return (
		<div
			data-slot="work-column"
			data-work-column={column.key}
			aria-current={marked ? "true" : undefined}
			className={cn(
				"flex h-full min-w-[22rem] flex-1 flex-col overflow-hidden border-glass-hairline not-first:border-l",
				marked && "bg-glass-tint",
			)}
		>
			{isShellRowKey(column.key) ? (
				<WorkShellColumn shellKey={column.key} dayStart={dayStart} />
			) : (
				<WorkAgentColumn
					agentId={column.key}
					column={column}
					dayStart={dayStart}
				/>
			)}
		</div>
	);
}

function WorkAgentColumn({
	agentId,
	column,
	dayStart,
}: {
	agentId: string;
	column: WorkDetailColumnPlace;
	dayStart: number;
}) {
	const agent = useIndexedAgent(agentId);
	const hydrated = useAgentRegistryHydrated();
	if (agent) {
		return (
			<WorkAgentDetail agent={agent} column={column} dayStart={dayStart} />
		);
	}
	if (!hydrated) return null;
	// A pin outlives its agent until the person removes it: it never
	// disappears on its own.
	return (
		<div className="m-auto flex max-w-72 flex-col items-center gap-2 p-4 text-center">
			<p className="text-xs text-muted-foreground">{t("work.detail.removed")}</p>
			{column.pinned ? (
				<Button
					variant="ghost"
					size="xs"
					onClick={() => useWorkViewStore.getState().unpin(agentId)}
				>
					<PinOff />
					{t("work.detail.unpin")}
				</Button>
			) : null}
		</div>
	);
}

function WorkAgentDetail({
	agent,
	column,
	dayStart,
}: {
	agent: Agent;
	column: WorkDetailColumnPlace;
	dayStart: number;
}) {
	const select = useWorkViewStore((state) => state.select);
	const selected = useWorkViewStore((state) => state.selected);
	const relations = useAgentRelations();
	const agentIds = useMemo(() => [agent.id], [agent.id]);
	const target = useAgentRevealTargets(agentIds).get(agent.id);
	const spaceName = useAgentRevealSpaceNames(agentIds, "pane").get(agent.id);
	const placement = useAgentAttentionPlacement(agent.id, dayStart);
	const manager = relations.managerOf(agent.id);
	// The breadcrumb names the agents above, so the row itself names none.
	const facts = useAgentRowFacts(agent.id, {
		...placement,
		...(agent.branch ? { branch: agent.branch } : {}),
		...(spaceName ? { spaceName } : {}),
		...(manager ? { below: manager } : {}),
	});
	if (!facts) return null;
	// The managed fold below sums up what it manages, so the card does not.
	const { managed: _summedUpBelow, ...cardFacts } = facts;
	// The large window takes over the pane it was opened for, so it gets the
	// pane's owner id when the agent has one.
	const paneOwnerId =
		target?.kind === "pane" ? `${target.desktopId}:${target.panelId}` : undefined;
	const openLargeWindow = agentSessionWindowTarget(agent)
		? () => void openAgentSessionWindow(agent.id, facts.title, paneOwnerId)
		: undefined;
	return (
		// A size container, so the managed rows' cap is a share of this detail.
		<section
			aria-label={facts.title}
			className="flex min-h-0 flex-1 flex-col [container-type:size]"
		>
			<header className="flex shrink-0 flex-col gap-1.5 p-3">
				<WorkBreadcrumb agentId={agent.id} onSelect={select} />
				<AgentRow row={agentRowModel(cardFacts)} variant="card" />
				<WorkAlsoManagedBy agentId={agent.id} onSelect={select} />
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
					<WorkPinControls agentId={agent.id} pinned={column.pinned} />
				</div>
			</header>
			<WorkManagedList
				agentId={agent.id}
				dayStart={dayStart}
				selected={selected}
				onSelect={select}
			/>
			<PaneLabel>{t("work.conversation.label")}</PaneLabel>
			<WorkConversation agent={agent} onOpenLargeWindow={openLargeWindow} />
		</section>
	);
}

/** Pin this agent beside the others, or unpin it; a pinned column moves
 * left or right among the pinned ones. */
function WorkPinControls({
	agentId,
	pinned,
}: {
	agentId: string;
	pinned: boolean;
}) {
	const order = useWorkViewStore((state) => state.pinned);
	const index = order.indexOf(agentId);
	const { pin, unpin, movePin } = useWorkViewStore.getState();
	return (
		<span className="ml-auto flex items-center gap-0.5">
			{pinned && order.length > 1 && (
				<>
					<IconButton
						title={t("work.detail.moveLeft")}
						disabled={index <= 0}
						onClick={() => movePin(agentId, -1)}
					>
						<ChevronLeft />
					</IconButton>
					<IconButton
						title={t("work.detail.moveRight")}
						disabled={index === -1 || index >= order.length - 1}
						onClick={() => movePin(agentId, 1)}
					>
						<ChevronRight />
					</IconButton>
				</>
			)}
			<IconButton
				title={pinned ? t("work.detail.unpin") : t("work.detail.pin")}
				pressed={pinned}
				onClick={() => (pinned ? unpin(agentId) : pin(agentId))}
			>
				{pinned ? <PinOff /> : <Pin />}
			</IconButton>
		</span>
	);
}

/** A plain shell pane: its card, the way to its pane and the agents started
 * from it. It has no Agent record, so no conversation or pin. */
function WorkShellColumn({
	shellKey,
	dayStart,
}: {
	shellKey: string;
	dayStart: number;
}) {
	const shell = useWorkShell(shellKey);
	if (!shell) return <WorkDetailEmpty />;
	return <WorkShellDetail shell={shell} dayStart={dayStart} />;
}

function WorkShellDetail({
	shell,
	dayStart,
}: {
	shell: WorkShellEntry;
	dayStart: number;
}) {
	const select = useWorkViewStore((state) => state.select);
	const selected = useWorkViewStore((state) => state.selected);
	// The managed fold below sums up what it manages, so the card does not.
	const { managed: _summedUpBelow, ...cardFacts } = useWorkShellRowFacts(shell);
	return (
		// A size container, so the managed rows' cap is a share of this detail.
		<section
			aria-label={shell.title}
			className="flex min-h-0 flex-1 flex-col [container-type:size]"
		>
			<header className="flex w-full max-w-xl shrink-0 flex-col gap-1.5 p-3">
				<AgentRow row={agentRowModel(cardFacts)} variant="card" />
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
			</header>
			<WorkManagedList
				agentId={shell.key}
				dayStart={dayStart}
				selected={selected}
				onSelect={select}
			/>
		</section>
	);
}

export function WorkDetailEmpty() {
	return (
		<p className="m-auto max-w-72 text-center text-xs text-muted-foreground">
			{t("work.detail.empty")}
		</p>
	);
}
