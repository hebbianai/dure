import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared monospace block for commands, stack traces, and pairing payloads
 * (MobilePairingPage command blocks, AppErrorBoundary stack pre). Content is
 * plain children; the block owns the bordered muted fill, monospace tier,
 * and internal scrolling. `selectable` opts the block into text selection
 * through the global `[data-selectable]` rule — the app disables selection
 * by default, and copyable commands must re-enable it. `maxHeightClass`
 * bounds tall logs so scrolling stays inside the block, never the page.
 */
export function CodeBlock({
	selectable = false,
	maxHeightClass,
	className,
	children,
}: {
	selectable?: boolean;
	maxHeightClass?: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<pre
			data-selectable={selectable || undefined}
			className={cn(
				"overflow-auto rounded-md border border-border/60 bg-muted/30 p-2.5 font-mono text-[11px] whitespace-pre-wrap",
				maxHeightClass,
				className,
			)}
		>
			{children}
		</pre>
	);
}
