import { DureLoader } from "@/components/ui/dure-loader";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shared status blocks for sidebar panes and dialogs: the loading row,
// destructive error banner, and centered empty hint used across domain
// clusters. Callers own their copy (t() strings come in as children) and
// keep per-site spacing via className; tailwind-merge lets a caller's
// padding override the defaults here.

export function LoadingRow({
	className,
	children,
}: {
	className?: string;
	children?: ReactNode;
}) {
	return (
		<div
			role="status"
			className={cn(
				"flex items-center gap-2 text-xs text-muted-foreground",
				className,
			)}
		>
			<DureLoader decorative />
			{children}
		</div>
	);
}

export function EmptyHint({
	className,
	children,
}: {
	className?: string;
	children?: ReactNode;
}) {
	return (
		<p
			className={cn(
				"py-5 text-center text-xs text-muted-foreground",
				className,
			)}
		>
			{children}
		</p>
	);
}
