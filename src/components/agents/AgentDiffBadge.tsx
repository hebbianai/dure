import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { hasChanges, normalizeDiffBadge } from "@/lib/scm/status/diffBadges";
import { useDiffBadges } from "@/lib/scm/status/diffBadgesStore";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** fork-point 대비 변경량. Agents 탭이 아니라 세션이 보이는 어느 행에서도 쓴다.
 * `onClick` is the diff-window launcher; leave it out where that window
 * cannot open (SSH worktrees) and the counters render as a plain indicator. */
export function AgentDiffBadge({
	agentId,
	onClick,
	className,
}: {
	agentId: string;
	onClick?: () => void;
	className?: string;
}) {
	const storedBadge = useDiffBadges((state) => state.badges[agentId]);
	if (!storedBadge) return null;
	const badge = normalizeDiffBadge(storedBadge);
	const hasPatch = hasChanges(badge);
	if (!hasPatch && badge.behind === 0) return null;
	const tooltipLabel = t("common.changes");
	const tooltipDescription = hasPatch
		? t("agents.diff.patchSummary", {
					taskFiles: badge.committed.files,
					wipFiles: badge.worktree.files,
					ahead: badge.ahead,
					behind: badge.behind,
				})
		: t("agents.diff.noLocalPatch", {
				behind: badge.behind,
			});
	const content = (
		<>
			{badge.committed.files > 0 && (
				<span className="text-vcs-added">C{badge.committed.files}</span>
			)}
			{badge.worktree.files > 0 && (
				<span className="text-vcs-modified">W{badge.worktree.files}</span>
			)}
			{badge.ahead > 0 && <span className="text-muted-foreground">↑{badge.ahead}</span>}
			{badge.behind > 0 && <span className="text-muted-foreground">↓{badge.behind}</span>}
		</>
	);

	if (!hasPatch || !onClick) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<span
						className={cn(
							"flex shrink-0 items-center gap-1 rounded font-mono text-meta leading-none",
							className,
						)}
						aria-label={tooltipDescription}
						role="img"
					>
						{content}
					</span>
				</TooltipTrigger>
				<TooltipContent description={tooltipDescription}>
					{tooltipLabel}
				</TooltipContent>
			</Tooltip>
		);
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex shrink-0 items-center gap-1 rounded font-mono text-meta leading-none hover:bg-glass-tint-hover",
						className,
					)}
					aria-label={tooltipDescription}
					onClick={(event) => {
						event.stopPropagation();
						onClick();
					}}
				>
					{content}
				</button>
			</TooltipTrigger>
			<TooltipContent description={tooltipDescription}>
				{tooltipLabel}
			</TooltipContent>
		</Tooltip>
	);
}
