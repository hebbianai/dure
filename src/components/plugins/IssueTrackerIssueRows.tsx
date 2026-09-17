import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { Trash2 } from "lucide-react";
import { WorkSignalPill } from "@/components/common/WorkSignalPill";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import type { IssueTrackerIssueSummaryV1 } from "@/contracts/generated/extensionContracts";
import { t } from "@/lib/i18n";

export type IssueTrackerRowAction = "open" | "start";

function IssueSummary({
	issue,
	onOpen,
	action,
	onAction,
}: {
	issue: IssueTrackerIssueSummaryV1;
	onOpen?: () => void;
	action: IssueTrackerRowAction | null;
	onAction: () => void;
}) {
	const blocked = issue.status.toLowerCase() === "blocked";
	const context = [issue.assignee, issue.issue_type]
		.filter(Boolean)
		.join(" · ");
	return (
		<div
			data-testid={`issue-tracker-row-${issue.id}`}
			className="px-2 py-1 transition-colors hover:bg-sidebar-accent/40"
		>
			<div className="flex min-w-0 items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
				<button
					type="button"
					className="w-0 min-w-0 flex-1 rounded text-left text-[11px] font-medium text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
					disabled={!onOpen}
					onClick={onOpen}
				>
					<OverflowRevealText text={issue.title} />
				</button>
				{issue.priority !== null && (
					<span className="shrink-0 font-mono tabular-nums">
						P{issue.priority}
					</span>
				)}
			</div>
			<div className="mt-0.5 flex min-w-0 items-center gap-1">
				<WorkSignalPill compact tone={blocked ? "attention" : "quiet"}>
					{issue.status}
				</WorkSignalPill>
				{issue.dependency_count > 0 && (
					<WorkSignalPill compact tone="attention">
						{t("plugins.issueTracker.blockerCount", {
							n: issue.dependency_count,
						})}
					</WorkSignalPill>
				)}
				<OverflowRevealText className="min-w-0 flex-1 text-[10px] text-muted-foreground" text={context} />
				{action && (
					<Button
						type="button"
						variant="outline"
						size="xs"
						className="h-5 shrink-0 rounded px-1.5 text-[10px]"
						onClick={onAction}
					>
						{action === "open"
							? t("common.open")
							: t("plugins.issueTracker.work.start")}
					</Button>
				)}
			</div>
		</div>
	);
}

/** The issue list. A destructive action arms in place: the armed row is
 * replaced by its confirm, so the list never grows a second surface and the
 * user reads the exact id being deleted (SOUL §6). Deletion itself belongs to
 * the caller, which owns the workspace binding. */
export function IssueTrackerIssueRows({
	issues,
	canOpen,
	onOpen,
	workActionForIssue,
	onWorkAction,
	canClose,
	onClose,
	canDelete,
	confirmDeleteId,
	onArmDelete,
	onCancelDelete,
	onConfirmDelete,
}: {
	issues: IssueTrackerIssueSummaryV1[];
	canOpen: boolean;
	onOpen: (issueId: string) => void;
	workActionForIssue: (
		issue: IssueTrackerIssueSummaryV1,
	) => IssueTrackerRowAction | null;
	onWorkAction: (issue: IssueTrackerIssueSummaryV1) => void;
	/** Closing is reversible, so it runs straight from the menu. */
	canClose: boolean;
	onClose: (issueId: string) => void;
	canDelete: boolean;
	confirmDeleteId: string | null;
	onArmDelete: (issueId: string) => void;
	onCancelDelete: () => void;
	onConfirmDelete: (issueId: string) => void;
}) {
	return (
		<ul className="divide-y divide-border/55">
			{issues.map((issue) => {
				const row = (
					<IssueSummary
						issue={issue}
						onOpen={canOpen ? () => onOpen(issue.id) : undefined}
						action={workActionForIssue(issue)}
						onAction={() => onWorkAction(issue)}
					/>
				);
				if (confirmDeleteId === issue.id) {
					return (
						<li key={issue.id}>
							<InlineConfirmRow
								question={t("plugins.issueTracker.delete.confirm", {
									id: issue.id,
								})}
								confirmLabel={t("plugins.issueTracker.delete.confirmLabel")}
								onConfirm={() => onConfirmDelete(issue.id)}
								onCancel={onCancelDelete}
							/>
						</li>
					);
				}
				if (!canClose && !canDelete) return <li key={issue.id}>{row}</li>;
				return (
					<li key={issue.id}>
						<ContextMenu>
							<ContextMenuTrigger asChild>
								<div>{row}</div>
							</ContextMenuTrigger>
							<ContextMenuContent>
								{canClose && (
									<ContextMenuItem onClick={() => onClose(issue.id)}>
										{t("plugins.issueTracker.close.action")}
									</ContextMenuItem>
								)}
								{canDelete && (
									<>
										{canClose && <ContextMenuSeparator />}
										<ContextMenuItem
											variant="destructive"
											onClick={() => onArmDelete(issue.id)}
										>
											<Trash2 />
											{t("plugins.issueTracker.delete.action")}
										</ContextMenuItem>
									</>
								)}
							</ContextMenuContent>
						</ContextMenu>
					</li>
				);
			})}
		</ul>
	);
}
