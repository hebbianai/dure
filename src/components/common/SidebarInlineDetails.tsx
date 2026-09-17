import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

/** A quiet, full-width disclosure surface nested inside a sidebar row.
 *
 *  It carries no left indent of its own: the details line up with the row's
 *  text column, and only the row knows where that column starts. A session
 *  row starts it at the row edge, so its details sit flush; a space row that
 *  leads with a glyph passes the offset that clears it. The 13px this used
 *  to bake in matched neither once the session row lost its icon chip
 *  (owner report 2026-09-08).
 *
 *  The rule takes 8px above and below — the sidebar's fill value, and the
 *  same breathing room a card gives the rule over its action (owner call
 *  2026-09-09; it was 6/6 while that one was 10/8). */
export function SidebarInlineDetails({
	className,
	...props
}: ComponentPropsWithoutRef<"div">) {
	return (
		<div
			{...props}
			data-slot="sidebar-inline-details"
			className={cn(
				"mt-2 min-w-0 basis-full border-t border-glass-hairline pt-2 text-meta text-muted-foreground select-text",
				className,
			)}
		/>
	);
}
