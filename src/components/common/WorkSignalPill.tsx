import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Achromatic by default; attention and danger are reserved for intervention. */
export function WorkSignalPill({
	children,
	tone = "quiet",
	compact = false,
}: {
	children: ReactNode;
	tone?: "quiet" | "attention" | "danger";
	compact?: boolean;
}) {
	return (
		<Badge
			variant={tone === "danger" ? "destructive" : "outline"}
			size="sm"
			className={cn(
				"max-w-full rounded-full text-[11px]",
				compact && "rounded px-1 py-0 text-[9px] leading-4",
				tone === "attention" &&
					"border-status-warn/35 bg-status-warn/8 text-status-warn",
				tone === "quiet" && "bg-muted/35 text-muted-foreground",
			)}
		>
			<span className="truncate">{children}</span>
		</Badge>
	);
}
