import { DureLoader } from "@/components/ui/dure-loader";
import { t } from "@/lib/i18n";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Centered status block filling its pane/panel body — the shared shell for
 * empty, error, and unavailable states. Pure slot component: callers compose
 * icon, message paragraphs, and action buttons as children (the gap column
 * spaces them); domain copy and retry policy stay at the call site.
 * `size` matches the two text tiers used across panels (sm) and panes (xs).
 */
export function PanelStatus({
	children,
	size = "sm",
	role,
	className,
}: {
	children: ReactNode;
	size?: "sm" | "xs";
	role?: "status" | "alert";
	className?: string;
}) {
	return (
		<div
			role={role}
			className={cn(
				"flex h-full flex-col items-center justify-center gap-2 text-muted-foreground",
				size === "sm" ? "text-sm" : "text-xs",
				className,
			)}
		>
			{children}
		</div>
	);
}

/** The one loading state every empty screen shows: the loader and "Loading…"
 *  centred in the area the content will take (owner call 2026-09-10 — it
 *  used to sit top-left in the sidebar tabs and centred in panes). A list
 *  that already shows rows keeps its inline row loader; this is for the
 *  screen that has nothing yet. `flex-1` from the caller fills a flex column. */
export function LoadingStatus({
	size = "xs",
	label,
	className,
}: {
	size?: "sm" | "xs";
	label?: string;
	className?: string;
}) {
	return (
		<PanelStatus role="status" size={size} className={className}>
			<DureLoader decorative />
			<span>{label ?? t("common.loading")}</span>
		</PanelStatus>
	);
}
