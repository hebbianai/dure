import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import {
	type AgentListRowVariant,
	AgentRow,
} from "@/components/agents/AgentRow";
import { useAgentRowFacts } from "@/components/agents/useAgentRowFacts";
import { useAgentAttentionPlacement } from "@/components/agents/useNextUp";
import { SectionHeaderRow } from "@/components/sidebar/SidebarItems";
import { Segmented } from "@/components/ui/segmented";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import { Disclosure } from "@/components/ui/disclosure";
import {
	useWorkView,
	type WorkShellEntry,
	type WorkView,
} from "@/components/work/useWorkView";
import { agentRowModel } from "@/lib/agents/agentRowModel";
import { t } from "@/lib/i18n";
import { useHeldWhilePresent } from "@/lib/ui/heldWhilePresent";
import { cn } from "@/lib/utils";
import {
	type WorkDepth,
	type WorkListFold,
	type WorkListRow,
	workListFoldKeys,
	workListOrder,
} from "@/lib/work/workViewList";
import { useWorkViewStore } from "@/lib/work/workViewStore";

/** How far one level of nesting indents a row under its manager. */
const LEVEL_INDENT_PX = 12;

/** The Work view's list: every agent in every project and on every backend,
 * what needs a person at any depth with its path, each group's ended agents
 * and today's results, folded. Selecting a row only changes the selection: it
 * mounts no terminal, opens no pane and acknowledges nothing. While the
 * pointer or focus is in the list its arrangement holds still. */
export function WorkList({ className }: { className?: string }) {
	const view = useWorkView();
	const { value: list, region, presence } = useHeldWhilePresent(view.list);
	const selected = useWorkViewStore((state) => state.selected);
	const select = useWorkViewStore((state) => state.select);
	const openFolds = useWorkViewStore((state) => state.openFolds);
	const grouping = useWorkViewStore((state) => state.grouping);
	const scroller = useRef<HTMLDivElement>(null);
	const empty = list.groups.length === 0;
	const listFolds = workListFoldKeys(list);
	const rows = (listed: readonly WorkListRow[]) => (
		<WorkRows rows={listed} view={view} selected={selected} onSelect={select} />
	);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const keys = workListOrder(list, openFolds);
		if (keys.length === 0) return;
		const index = selected === null ? -1 : keys.indexOf(selected);
		const next =
			event.key === "ArrowDown"
				? keys[Math.min(keys.length - 1, index + 1)]
				: event.key === "ArrowUp"
					? keys[Math.max(0, index - 1)]
					: event.key === "Home"
						? keys[0]
						: event.key === "End"
							? keys[keys.length - 1]
							: undefined;
		if (next === undefined) return;
		event.preventDefault();
		select(next);
		scroller.current
			?.querySelector<HTMLElement>(
				`[data-agent-row-key="${CSS.escape(next)}"]`,
			)
			?.focus();
	};

	return (
		<div
			data-slot="work-list"
			className={cn("flex min-h-0 min-w-0 flex-col", className)}
		>
			<SectionHeaderRow
				as="h2"
				className="shrink-0"
				label={t("work.title")}
			/>
			<WorkListOptions />
			{empty ? (
				<p className="px-3 py-2 text-meta text-muted-foreground">
					{t("work.list.empty")}
				</p>
			) : (
				<SidebarScrollArea
					edgeFade
					className="min-h-0 flex-1"
					viewportClassName="pb-3"
					viewportRef={scroller}
				>
					{/* Arrow keys, Home and End move the selection between the rows. */}
					<div
						ref={region}
						className="px-1.5"
						onKeyDown={onKeyDown}
						{...presence}
					>
						{list.needsYou.length > 0 && (
							<WorkSection heading={t("agents.nextUp.needsYou")}>
								{rows(list.needsYou)}
							</WorkSection>
						)}
						{list.groups.map((group) => (
							<WorkSection
								key={group.key}
								heading={
									grouping === "none"
										? undefined
										: (group.projectName ?? t("work.list.noProject"))
								}
							>
								{rows(group.rows)}
								{/* Finished work stays quiet, at the group heading's tone. */}
								<WorkFold
									fold={group.ended}
									label={t("work.list.ended")}
									listFolds={listFolds}
									summaryClassName="text-muted-foreground hover:text-foreground"
								>
									{rows(group.ended.rows)}
								</WorkFold>
							</WorkSection>
						))}
						<WorkFold
							fold={list.resultsToday}
							label={t("work.list.resultsToday")}
							listFolds={listFolds}
						>
							{rows(list.resultsToday.rows)}
						</WorkFold>
					</div>
				</SidebarScrollArea>
			)}
		</div>
	);
}

function WorkListOptions() {
	const depth = useWorkViewStore((state) => state.depth);
	const setDepth = useWorkViewStore((state) => state.setDepth);
	const grouping = useWorkViewStore((state) => state.grouping);
	const setGrouping = useWorkViewStore((state) => state.setGrouping);
	return (
		<div className="flex shrink-0 items-center gap-2 px-3 pt-1 pb-2">
			<Segmented<WorkDepth>
				variant="pills"
				size="sm"
				className="min-w-0 flex-1"
				aria-label={t("work.list.depth")}
				value={depth}
				onChange={setDepth}
				options={[
					{ value: "top", label: t("work.list.topLevel") },
					{ value: "all", label: t("work.list.expandAll") },
				]}
			/>
			<button
				type="button"
				aria-pressed={grouping === "project"}
				className={cn(
					"h-6 shrink-0 rounded-md px-2 text-meta outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
					grouping === "project"
						? "bg-glass-tint-selected text-foreground"
						: "text-muted-foreground hover:bg-glass-tint-hover hover:text-foreground",
				)}
				onClick={() => setGrouping(grouping === "project" ? "none" : "project")}
			>
				{t("work.list.byProject")}
			</button>
		</div>
	);
}

function WorkSection({
	heading,
	children,
}: {
	/** Absent for the one list shown without grouping. */
	heading: string | undefined;
	children: ReactNode;
}) {
	const headingId = useId();
	const labelled = heading !== undefined;
	return (
		<section
			aria-labelledby={labelled ? headingId : undefined}
			className="pb-1"
		>
			{labelled && (
				<h3
					id={headingId}
					className="flex h-7 items-center px-2 text-meta font-medium text-muted-foreground"
				>
					{heading}
				</h3>
			)}
			{children}
		</section>
	);
}

/** A folded part of the list, labelled with how many rows it holds, open
 * while the person keeps it open; absent when it holds none. Its summary
 * stands as tall as a section heading, its chevron on the rows' dot column
 * and its label on their title column; the rows it reveals line up with the
 * rows above. */
function WorkFold({
	fold,
	label,
	listFolds,
	summaryClassName,
	children,
}: {
	fold: WorkListFold;
	label: string;
	/** Every fold the list has now; a saved key matching none is dropped. */
	listFolds: readonly string[];
	summaryClassName?: string;
	children: ReactNode;
}) {
	const open = useWorkViewStore((state) => state.openFolds.includes(fold.key));
	const setFoldOpen = useWorkViewStore((state) => state.setFoldOpen);
	if (fold.rows.length === 0) return null;
	return (
		<Disclosure
			size="meta"
			summaryClassName={cn("h-7 px-1.5", summaryClassName)}
			bodyClassName="mt-0 pl-0"
			open={open}
			onOpenChange={(next) => setFoldOpen(fold.key, next, listFolds)}
			label={`${label} · ${fold.rows.length}`}
		>
			{children}
		</Disclosure>
	);
}

/** Rows in reading order; absent when there are none. */
function WorkRows({
	rows,
	view,
	selected,
	onSelect,
}: {
	rows: readonly WorkListRow[];
	view: WorkView;
	selected: string | null;
	onSelect: (key: string) => void;
}) {
	if (rows.length === 0) return null;
	return (
		<ul>
			{rows.map((row) => (
				<WorkRow
					key={row.key}
					row={row}
					view={view}
					selected={selected === row.key}
					onSelect={onSelect}
				/>
			))}
		</ul>
	);
}

function WorkRow({
	row,
	view,
	selected,
	onSelect,
}: {
	row: WorkListRow;
	view: WorkView;
	selected: boolean;
	onSelect: (key: string) => void;
}) {
	const shell = view.shells.get(row.key);
	return (
		<li style={row.level > 0 ? { paddingLeft: row.level * LEVEL_INDENT_PX } : undefined}>
			{shell ? (
				<WorkShellRow shell={shell} selected={selected} onSelect={onSelect} />
			) : (
				<WorkAgentRow
					agentId={row.key}
					under={row.under}
					spaceName={view.spaceNames.get(row.key)}
					dayStart={view.dayStart}
					selected={selected}
					onSelect={onSelect}
				/>
			)}
		</li>
	);
}

/** One Agent's row, reporting it the way every row does, with the Work
 * view's result window: a result since the start of the day. Under its
 * manager (Expand all, or a detail's managed list) the indentation or the
 * list shows the path, so the row names only the managers below that one. */
export function WorkAgentRow({
	agentId,
	under,
	spaceName,
	dayStart,
	selected = false,
	variant = "list",
	onSelect,
}: {
	agentId: string;
	under?: string;
	spaceName: string | undefined;
	dayStart: number;
	selected?: boolean;
	variant?: AgentListRowVariant;
	onSelect?: (key: string) => void;
}) {
	const placement = useAgentAttentionPlacement(agentId, dayStart);
	const facts = useAgentRowFacts(agentId, {
		...placement,
		...(spaceName ? { spaceName } : {}),
		...(under ? { below: under } : {}),
	});
	if (!facts) return null;
	return (
		<AgentRow
			row={agentRowModel(facts)}
			variant={variant}
			selected={selected}
			onSelect={onSelect}
		/>
	);
}

/** A provider found in a plain shell pane, reported by the same row: its
 * state and, when the needs-person rule flags it, why. */
export function WorkShellRow({
	shell,
	selected = false,
	variant = "list",
	onSelect,
}: {
	shell: WorkShellEntry;
	selected?: boolean;
	variant?: AgentListRowVariant;
	onSelect?: (key: string) => void;
}) {
	return (
		<AgentRow
			row={agentRowModel({
				agentId: shell.key,
				title: shell.title,
				...(shell.state ? { state: shell.state } : {}),
				...(shell.needsPerson
					? { needsPerson: { reason: shell.needsPerson } }
					: {}),
				...(shell.projectName ? { projectName: shell.projectName } : {}),
				...(shell.spaceName ? { spaceName: shell.spaceName } : {}),
			})}
			variant={variant}
			selected={selected}
			onSelect={onSelect}
		/>
	);
}
