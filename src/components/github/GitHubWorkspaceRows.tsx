import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import {
	ArrowRight,
	CircleCheck,
	CircleDot,
	CircleSlash,
	Copy,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	PanelsTopLeft,
} from "lucide-react";

import { Fragment } from "react";
import { WorkSignalPill } from "@/components/common/WorkSignalPill";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuTrigger,
	ContextMenuContent,
	ContextMenuItem,
} from "@/components/ui/context-menu";
import { encodeGitHubIssueDrag } from "@/lib/github/githubIssueDrag";
import { DURE_NEW_PANE_DRAG_TYPE } from "@/lib/platform/productDragPayload";
import { openGitHubIssuePanel } from "@/lib/workspace/dock/openGitHubIssuePanel";
import { requestQuickDispatch } from "@/lib/agents/quickDispatch/quickDispatchActivation";
import { githubIssueTargetKey } from "@/lib/github/githubIssuePane";
import type {
	GitHubProjectRow,
	GitHubWorkItemRow,
} from "@/lib/github/githubResponses";
import {
	type GitHubWorkspaceView,
	githubStartPrefill,
} from "@/lib/github/githubWorkspace";
import { t } from "@/lib/i18n";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import { defaultBranchName } from "@/lib/scm/worktrees/worktreePlan";
import { formatRelativeAge } from "@/lib/ui/relativeAge";
import { cn } from "@/lib/utils";
import { openAgentPanelOnDesktop } from "@/lib/workspace/dock";
import type { Agent } from "@/types";

/** GitHub sends ISO timestamps; one it cannot parse shows a dash. */
function relativeUpdatedAt(value: string): string {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? formatRelativeAge(timestamp) : "—";
}

function matchingAgent(
	row: GitHubWorkItemRow,
	agents: readonly Agent[],
): Agent | undefined {
	const prefill = githubStartPrefill(row);
	const expectedBranch = defaultBranchName(prefill.typedName);
	return agents.find(
		(candidate) =>
			candidate.projectId === row.repository.projectId &&
			(candidate.name === prefill.typedName ||
				candidate.branch === expectedBranch),
	);
}

function rowPeople(row: GitHubWorkItemRow): string[] {
	return [
		...(row.author ? [row.author] : []),
		...row.assignees,
		...row.reviewRequests,
	].filter((value, index, all) => all.indexOf(value) === index);
}

export function WorkItemAction({
	row,
	agents,
	activeSpaceId,
	compact = false,
}: {
	row: GitHubWorkItemRow;
	agents: readonly Agent[];
	activeSpaceId: string;
	compact?: boolean;
}) {
	const prefill = githubStartPrefill(row);
	const agent = matchingAgent(row, agents);
	return (
		<Button
			type="button"
			variant={compact ? "glass" : "outline"}
			size={compact ? "xs" : "sm"}
			className={cn(compact && "text-meta")}
			onClick={() => {
				if (agent) openAgentPanelOnDesktop(activeSpaceId, agent);
				else requestQuickDispatch(prefill);
			}}
		>
			{agent ? t("common.open") : t("github.workspace.start")}
			{!compact && <ArrowRight className="size-3.5" />}
		</Button>
	);
}

function CheckSignal({
	row,
	compact = false,
}: {
	row: GitHubWorkItemRow;
	compact?: boolean;
}) {
	if (row.checks.total > 0) {
		if (row.checks.failed > 0) {
			return (
				<WorkSignalPill tone="danger" compact={compact}>
					{t("github.workspace.signal.checksFailed", {
						count: row.checks.failed,
					})}
				</WorkSignalPill>
			);
		}
		if (row.checks.pending > 0) {
			return (
				<WorkSignalPill tone="attention" compact={compact}>
					{t("github.workspace.signal.checksPending", {
						count: row.checks.pending,
					})}
				</WorkSignalPill>
			);
		}
		return (
			<WorkSignalPill compact={compact}>
				{t("github.workspace.signal.checksPassed", {
					passed: row.checks.passed,
					total: row.checks.total,
				})}
			</WorkSignalPill>
		);
	}
	return (
		<WorkSignalPill compact={compact}>
			{t("github.workspace.signal.noChecks")}
		</WorkSignalPill>
	);
}

function StateSignal({
	row,
	compact = false,
}: {
	row: GitHubWorkItemRow;
	compact?: boolean;
}) {
	return (
		<WorkSignalPill compact={compact}>{workItemStateLabel(row)}</WorkSignalPill>
	);
}

export function workItemStateLabel(row: GitHubWorkItemRow): string {
	if (row.kind === "issue" && row.state === "CLOSED") {
		if (row.stateReason === "NOT_PLANNED") return t("github.detail.notPlanned");
		if (row.stateReason === "DUPLICATE") return t("github.detail.duplicate");
	}
	const messageId =
		row.state === "MERGED"
			? "github.workspace.signal.merged"
			: row.state === "CLOSED"
				? "github.workspace.signal.closed"
				: "github.workspace.signal.open";
	return t(messageId);
}

export function CompactWorkItemStateIcon({ row }: { row: GitHubWorkItemRow }) {
	const label = workItemStateLabel(row);
	let Icon = GitPullRequest;
	let tone = "text-status-run";
	if (row.kind === "issue") {
		Icon = row.state === "CLOSED" ? CircleCheck : CircleDot;
		if (row.state === "CLOSED") tone = "text-status-done";
		if (
			row.state === "CLOSED" &&
			(row.stateReason === "NOT_PLANNED" || row.stateReason === "DUPLICATE")
		) {
			Icon = row.stateReason === "DUPLICATE" ? Copy : CircleSlash;
			tone = "text-muted-foreground";
		}
	} else if (row.state === "MERGED") {
		Icon = GitMerge;
		tone = "text-status-done";
	} else if (row.state === "CLOSED") {
		Icon = GitPullRequestClosed;
		tone = "text-muted-foreground";
	}
	return (
		<Icon
			role="img"
			aria-label={label}
			className={cn("size-3.5 shrink-0", tone)}
		/>
	);
}

function MergeSignal({
	row,
	compact = false,
}: {
	row: GitHubWorkItemRow;
	compact?: boolean;
}) {
	if (row.state === "MERGED" || row.state === "CLOSED") {
		return <StateSignal row={row} compact={compact} />;
	}
	if (row.isDraft || row.mergeStateStatus === "DRAFT") {
		return (
			<WorkSignalPill compact={compact}>
				{t("github.workspace.signal.draft")}
			</WorkSignalPill>
		);
	}
	if (row.reviewDecision === "CHANGES_REQUESTED") {
		return (
			<WorkSignalPill tone="danger" compact={compact}>
				{t("github.workspace.signal.changesRequested")}
			</WorkSignalPill>
		);
	}
	switch (row.mergeStateStatus) {
		case "DIRTY":
			return (
				<WorkSignalPill tone="danger" compact={compact}>
					{t("github.workspace.signal.conflicts")}
				</WorkSignalPill>
			);
		case "BEHIND":
			return (
				<WorkSignalPill tone="attention" compact={compact}>
					{t("github.workspace.signal.behind")}
				</WorkSignalPill>
			);
		case "BLOCKED":
		case "UNSTABLE":
			return (
				<WorkSignalPill tone="attention" compact={compact}>
					{t("github.workspace.signal.blocked")}
				</WorkSignalPill>
			);
		case "CLEAN":
		case "HAS_HOOKS":
			return (
				<WorkSignalPill compact={compact}>
					{t("github.workspace.signal.readyToMerge")}
				</WorkSignalPill>
			);
		default:
			return (
				<WorkSignalPill compact={compact}>
					{row.reviewDecision === "APPROVED"
						? t("github.workspace.signal.approved")
						: t("github.workspace.signal.reviewRequired")}
				</WorkSignalPill>
			);
	}
}

function GitHubWorkItemTable({
	rows,
	agents,
	activeSpaceId,
	onSelect,
}: {
	rows: readonly GitHubWorkItemRow[];
	agents: readonly Agent[];
	activeSpaceId: string;
	onSelect: (row: GitHubWorkItemRow) => void;
}) {
	const pullRequests = rows[0]?.kind === "pr";
	return (
		<table
			className={cn(
				"w-full table-fixed border-collapse",
				pullRequests ? "min-w-[1040px]" : "min-w-[900px]",
			)}
		>
			<thead className="sticky top-0 z-10 bg-background">
				<tr className="h-9 border-b border-border/70 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
					<th className="w-28 px-5">{t("github.workspace.column.id")}</th>
					<th className="px-3">{t("github.workspace.column.work")}</th>
					<th className="w-44 px-3">{t("github.workspace.column.people")}</th>
					<th className="w-44 px-3">
						{pullRequests
							? t("github.workspace.column.checks")
							: t("github.workspace.column.signal")}
					</th>
					{pullRequests && (
						<th className="w-44 px-3">{t("github.workspace.column.merge")}</th>
					)}
					<th className="w-28 px-3">{t("github.workspace.column.updated")}</th>
					<th className="w-28 px-5 text-right">
						{t("github.workspace.column.action")}
					</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => {
					const people = rowPeople(row);
					return (
						<tr
							key={`${row.repository.projectId}:${row.kind}:${row.number}`}
							className="group h-[72px] border-b border-border/55 transition-colors hover:bg-muted/25"
						>
							<td className="px-5 align-middle">
								<button
									type="button"
									className="inline-flex items-center gap-2 rounded-md font-mono text-xs tabular-nums text-muted-foreground hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									onClick={() => onSelect(row)}
								>
									{row.kind === "pr" ? (
										<GitPullRequest className="size-3.5" />
									) : (
										<CircleDot className="size-3.5" />
									)}
									#{row.number}
								</button>
							</td>
							<td className="px-3 align-middle">
								<button
									type="button"
									className="block max-w-full text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									onClick={() => onSelect(row)}
								>
									<span className="block truncate text-sm font-medium">
										{row.title}
									</span>
									<span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
										{row.repository.nameWithOwner}
										{row.labels.length > 0
											? ` · ${row.labels.slice(0, 2).join(" · ")}`
											: ""}
									</span>
								</button>
							</td>
							<td className="px-3 align-middle font-mono text-xs text-muted-foreground">
								<span className="block truncate">
									{people.length > 0
										? people
												.slice(0, 3)
												.map((person) => `@${person}`)
												.join(" · ")
										: "—"}
								</span>
							</td>
							<td className="px-3 align-middle">
								{row.kind === "pr" ? (
									<CheckSignal row={row} />
								) : (
									<StateSignal row={row} />
								)}
							</td>
							{pullRequests && (
								<td className="px-3 align-middle">
									<MergeSignal row={row} />
								</td>
							)}
							<td className="px-3 align-middle font-mono text-xs tabular-nums text-muted-foreground">
								{relativeUpdatedAt(row.updatedAt)}
							</td>
							<td className="px-5 text-right align-middle">
								<WorkItemAction
									row={row}
									agents={agents}
									activeSpaceId={activeSpaceId}
								/>
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

function GitHubProjectTable({ rows }: { rows: readonly GitHubProjectRow[] }) {
	return (
		<table className="w-full min-w-[720px] table-fixed border-collapse">
			<thead className="sticky top-0 z-10 bg-background">
				<tr className="h-9 border-b border-border/70 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
					<th className="w-28 px-5">{t("github.workspace.column.id")}</th>
					<th className="px-3">{t("github.workspace.column.project")}</th>
					<th className="w-40 px-3">{t("github.workspace.column.owner")}</th>
					<th className="w-32 px-3">{t("github.workspace.column.items")}</th>
					<th className="w-28 px-5 text-right">
						{t("github.workspace.column.action")}
					</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => (
					<tr
						key={row.url}
						className="h-[72px] border-b border-border/55 transition-colors hover:bg-muted/25"
					>
						<td className="px-5 font-mono text-xs tabular-nums text-muted-foreground">
							P{row.number}
						</td>
						<td className="px-3">
							<button
								type="button"
								className="block max-w-full text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								onClick={() => void openExternalUrl(row.url)}
							>
								<span className="block truncate text-sm font-medium">
									{row.title}
								</span>
								<span className="mt-1 block truncate text-[11px] text-muted-foreground">
									{row.shortDescription ||
										t("github.workspace.project.noDescription")}
								</span>
							</button>
						</td>
						<td className="px-3 font-mono text-xs text-muted-foreground">@{row.owner}</td>
						<td className="px-3 font-mono text-xs tabular-nums text-muted-foreground">
							{row.itemCount ?? "—"}
						</td>
						<td className="px-5 text-right">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => void openExternalUrl(row.url)}
							>
								{t("common.open")}
								<ExternalLink className="size-3.5" />
							</Button>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/* The sidebar rows take the spaces tab's two-line row (owner call
 * 2026-09-08): a 32px-minimum row with 8px padding and a rounded hover fill,
 * the title on the 13px regular tier, and an info line in mono meta at 70%.
 * They used to be 10/11px with their own hover token and dividers.
 *
 * The 32px rhythm with 8px padding is what parts two-line rows — no hairline
 * and no card: filled surfaces on glass are what Glass v2 §1 D keeps off the
 * panel. The rows shipped at 28px/6px until 2026-09-10 (owner request: the
 * GitHub tab takes the other tabs' frame). */
function GitHubWorkItemList({
	rows,
	agents,
	activeSpaceId,
	onSelect,
	openIssueKeys,
}: {
	rows: readonly GitHubWorkItemRow[];
	agents: readonly Agent[];
	activeSpaceId: string;
	onSelect: (row: GitHubWorkItemRow) => void;
	/** Current issues shown in panes, independent of those panes' identities. */
	openIssueKeys?: ReadonlySet<string>;
}) {
	return (
		<ul className="px-2">
			{rows.map((row) => {
				const people = rowPeople(row);
				const metadata = [
					row.repository.nameWithOwner,
					...people.slice(0, 2).map((person) => `@${person}`),
					...row.labels.slice(0, 2),
				].join(" · ");
				return (
					<Fragment
						key={`${row.repository.projectId}:${row.kind}:${row.number}`}
					>
						<li>
							<ContextMenu>
								<ContextMenuTrigger asChild disabled={row.kind !== "issue"}>
									<div
										draggable={row.kind === "issue"}
										onDragStart={(event) => {
											if (row.kind !== "issue") return;
											event.dataTransfer.setData(DURE_NEW_PANE_DRAG_TYPE, "");
											event.dataTransfer.setData(
												"text/plain",
												encodeGitHubIssueDrag(row),
											);
											event.dataTransfer.effectAllowed = "copy";
										}}
										className={cn(
											"min-h-8 min-w-0 rounded-md px-2 py-2 transition-colors duration-150 ease-out hover:bg-glass-tint-hover",
											row.kind === "issue" &&
												openIssueKeys?.has(githubIssueTargetKey(row)) &&
												"bg-glass-tint-selected hover:bg-glass-tint-selected",
										)}
									>
										<div className="flex min-w-0 items-center gap-2 text-meta leading-4 text-muted-foreground">
											<button
												type="button"
												className="inline-flex shrink-0 items-center gap-1 rounded font-mono tabular-nums hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
												onClick={() => onSelect(row)}
											>
												<CompactWorkItemStateIcon row={row} />#{row.number}
											</button>
											<button
												type="button"
												className="min-w-0 flex-1 rounded text-left text-xs font-normal leading-4 text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
												onClick={() => onSelect(row)}
											>
												<OverflowRevealText text={row.title} />
											</button>
											<span className="shrink-0 font-mono tabular-nums">
												{relativeUpdatedAt(row.updatedAt)}
											</span>
										</div>
										<div className="mt-1 flex min-w-0 items-center gap-2">
											<OverflowRevealText text={metadata}
												className="min-w-0 flex-1 font-mono text-meta text-sidebar-foreground/70" />
											{row.kind === "pr" && (
												<div className="flex max-w-[52%] min-w-0 shrink-0 items-center gap-1 overflow-hidden">
													<CheckSignal row={row} compact />
													<MergeSignal row={row} compact />
												</div>
											)}
											<WorkItemAction
												row={row}
												agents={agents}
												activeSpaceId={activeSpaceId}
												compact
											/>
										</div>
									</div>
								</ContextMenuTrigger>
								{row.kind === "issue" && (
									<ContextMenuContent>
										<ContextMenuItem
											onSelect={() => openGitHubIssuePanel(activeSpaceId, row)}
										>
											<PanelsTopLeft />
											{t("github.workspace.openInNewPane")}
										</ContextMenuItem>
									</ContextMenuContent>
								)}
							</ContextMenu>
						</li>
					</Fragment>
				);
			})}
		</ul>
	);
}

function GitHubProjectList({ rows }: { rows: readonly GitHubProjectRow[] }) {
	return (
		<ul className="px-2">
			{rows.map((row) => (
				<Fragment key={row.url}>
					<li>
						<div className="min-h-8 min-w-0 rounded-md px-2 py-2 transition-colors duration-150 ease-out hover:bg-glass-tint-hover">
							<div className="flex min-w-0 items-center gap-2 text-meta leading-4 text-muted-foreground">
								<span className="shrink-0 font-mono tabular-nums">
									P{row.number}
								</span>
								<button
									type="button"
									className="min-w-0 flex-1 rounded text-left text-xs font-normal leading-4 text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									onClick={() => void openExternalUrl(row.url)}
								>
									<OverflowRevealText text={row.title} />
								</button>
								<span
									className="shrink-0 font-mono tabular-nums"
								>
									{row.itemCount ?? "—"}
								</span>
							</div>
							<div className="mt-1 flex min-w-0 items-center gap-2">
								<OverflowRevealText
									className="flex-1 font-mono text-meta text-sidebar-foreground/70"
									text={`@${row.owner} · ${row.shortDescription || t("github.workspace.project.noDescription")}`}
								/>
								<Button
									type="button"
									variant="glass"
									size="xs"
									className="text-meta"
									onClick={() => void openExternalUrl(row.url)}
								>
									{t("common.open")}
								</Button>
							</div>
						</div>
					</li>
				</Fragment>
			))}
		</ul>
	);
}

export function GitHubWorkspaceRows({
	form,
	view,
	workItems,
	projects,
	agents,
	activeSpaceId,
	onSelect,
	openIssueKeys,
}: {
	/** Which form to draw. The caller decides from the width it has, not from
	 * where it is mounted: the ledger's table has a hard minimum and a pane
	 * narrower than that used to clip it mid-column (owner report 2026-09-13). */
	form: "table" | "cards";
	view: GitHubWorkspaceView;
	workItems: readonly GitHubWorkItemRow[];
	projects: readonly GitHubProjectRow[];
	agents: readonly Agent[];
	activeSpaceId: string;
	onSelect: (row: GitHubWorkItemRow) => void;
	/** Current issues shown in panes, independent of those panes' identities. */
	openIssueKeys?: ReadonlySet<string>;
}) {
	if (view === "projects") {
		return form === "table" ? (
			<GitHubProjectTable rows={projects} />
		) : (
			<GitHubProjectList rows={projects} />
		);
	}
	return form === "table" ? (
		<GitHubWorkItemTable
			onSelect={onSelect}
			rows={workItems}
			agents={agents}
			activeSpaceId={activeSpaceId}
		/>
	) : (
		<GitHubWorkItemList
			onSelect={onSelect}
			rows={workItems}
			agents={agents}
			activeSpaceId={activeSpaceId}
			openIssueKeys={openIssueKeys}
		/>
	);
}
