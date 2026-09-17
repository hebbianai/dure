import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Footer under a truncated discovery list (external sessions, detected
 * worktrees, recovery rows). Renders nothing while every item is shown.
 * While a collapsible caller still holds rows behind its preview cap, the
 * ghost "show all" button expands them; once expanded — or while a search
 * owns the expansion — it degrades to the shared truncation hint that points
 * at search. Callers compute `searchActive` themselves: the sites gate on
 * different search inputs (panel query, Spaces search, none), and callers
 * without a show-all mechanism simply omit `onShowAll` to always get the
 * hint. `className` styles whichever element renders.
 */
export function DiscoveryListFooter({
	total,
	shown,
	showAll = false,
	searchActive = false,
	onShowAll,
	className,
}: {
	total: number;
	shown: number;
	showAll?: boolean;
	searchActive?: boolean;
	onShowAll?: () => void;
	className?: string;
}) {
	if (shown >= total) return null;
	if (onShowAll && !showAll && !searchActive) {
		return (
			<Button
				size="xs"
				variant="ghost"
				className={cn("w-full text-[10px] text-muted-foreground", className)}
				onClick={onShowAll}
			>
				{t("sessions.list.showAll")} ({total})
			</Button>
		);
	}
	return (
		<p
			className={cn(
				"py-2 text-center text-[10px] text-muted-foreground",
				className,
			)}
		>
			{t("sessions.list.truncated", {
				shown,
				total,
			})}
		</p>
	);
}
