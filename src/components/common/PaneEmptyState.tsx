import type { ReactNode } from "react";

import { PanelStatus } from "@/components/common/PanelStatus";
import { cn } from "@/lib/utils";

/**
 * What a pane shows when it has nothing to list.
 *
 * One shape for every tab: centred copy on the pane tier, an optional second
 * line, and the pane's one action full width beneath. This is the notice
 * source control and ssh always drew; github had grown a glyph in a ring
 * over a bold title, and for a day every tab wore that — the owner looked at
 * it and called the plain notice the house style, so all tabs return to it
 * together (2026-09-08).
 *
 * The copy follows the row ladder (brightness = scanning value). A lone
 * sentence is a notice and stays muted. With a second line the first becomes
 * a title — 13px medium in the sidebar foreground — and the second the 11px
 * muted explanation, 4px under it, the same two tiers a row uses for its
 * title and secondary line. Two muted 13px lines 8px apart read as two
 * unrelated sentences (owner report 2026-09-08).
 *
 * The bottom padding is heavier than the top on purpose. `PanelStatus` centres
 * on the geometric middle, and in a column this tall that reads as sitting
 * low; the extra weight below lifts the block to where the eye expects it.
 */
export function PaneEmptyState({
	title,
	description,
	action,
	compact = false,
	role,
	className,
}: {
	title: ReactNode;
	/** A second, muted line; its presence lifts `title` to the title tier. */
	description?: ReactNode;
	/** The pane's one action, rendered full width under the copy. */
	action?: ReactNode;
	/** Tighter for a sidebar-width pane. */
	compact?: boolean;
	role?: "status" | "alert";
	className?: string;
}) {
	return (
		<PanelStatus
			role={role}
			size="xs"
			className={cn(
				"min-h-0 flex-1 text-center",
				compact ? "px-4 pt-8 pb-24" : "px-6 pt-10 pb-28",
				className,
			)}
		>
			<div className="max-w-[220px]">
				<p
					className={cn(
						"leading-5",
						description && "font-medium text-sidebar-foreground",
					)}
				>
					{title}
				</p>
				{description ? (
					<p className="mt-1 text-meta leading-4 text-muted-foreground">{description}</p>
				) : null}
			</div>
			{action ? <div className="mt-1 w-full max-w-56">{action}</div> : null}
		</PanelStatus>
	);
}
