import type { ComponentProps, ReactNode } from "react";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { cn } from "@/lib/utils";

/** The one collapsible row: a native `<details>` whose summary is the fold
 * chevron (DisclosureChevron, 12px, right → down) before a medium label, with
 * the body hanging under the label at the chevron's width. Five sites drew
 * this over the browser's own marker with their own summary styles — an
 * underlined link, a bordered card, plain muted text (owner audit
 * 2026-09-13). ChatToolBurst's tool folds already wore the chevron and keep
 * their own row anatomy. Native open/close is kept: `open`, a ref and
 * `.open` behave as on `<details>`, so state-driven folds keep working.
 *
 * `size`: "xs" (12/18 — panes, cards, dialogs) or "meta" (11/15 — the
 * sidebar tier). `bodyClassName` replaces the body's default 4px gap. */
export function Disclosure({
	label,
	size = "xs",
	className,
	bodyClassName,
	children,
	...props
}: Omit<ComponentProps<"details">, "className"> & {
	label: ReactNode;
	size?: "xs" | "meta";
	className?: string;
	bodyClassName?: string;
}) {
	return (
		<details
			className={cn(
				"group/disclosure",
				size === "meta" ? "text-meta" : "text-xs",
				className,
			)}
			{...props}
		>
			<summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-foreground select-none [&::-webkit-details-marker]:hidden">
				<DisclosureChevron className="group-open/disclosure:rotate-90" />
				<span className="min-w-0 truncate">{label}</span>
			</summary>
			<div className={cn("mt-1 pl-[18px]", bodyClassName)}>{children}</div>
		</details>
	);
}
