import * as React from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Hover-intent delay before the label bubble opens. The native `title`
 * delay (~1.5s, browser-fixed) was reported as far too slow (2026-08-31). */
const TOOLTIP_OPEN_DELAY_MS = 100;

/** Width-staggered detail reveal (owner request 2026-09-01): a single shared
 * breakpoint popped every label at once and wrapped the bar to two rows at
 * middling widths. Each control instead names a reveal step; as the container
 * grows one more label unfolds per step, highest-priority first. Steps map to
 * Tailwind's container scale (sm 24rem → 3xl 48rem) — static literals, since
 * arbitrary values would not be generated. */
export type ToolbarControlReveal = 0 | 1 | 2 | 3 | 4 | 5;
const DETAIL_REVEAL: Record<ToolbarControlReveal, string> = {
	0: "@max-sm/agent-panel-toolbar:hidden @max-sm/chat:hidden",
	1: "@max-md/agent-panel-toolbar:hidden @max-md/chat:hidden",
	2: "@max-lg/agent-panel-toolbar:hidden @max-lg/chat:hidden",
	3: "@max-xl/agent-panel-toolbar:hidden @max-xl/chat:hidden",
	4: "@max-2xl/agent-panel-toolbar:hidden @max-2xl/chat:hidden",
	5: "@max-3xl/agent-panel-toolbar:hidden @max-3xl/chat:hidden",
};

function composeHandlers<E extends React.SyntheticEvent>(
	theirs: ((event: E) => void) | undefined,
	ours: (event: E) => void,
): (event: E) => void {
	return (event) => {
		theirs?.(event);
		ours(event);
	};
}

/** Canonical pane-toolbar control: one 24px-high compact trigger shape shared
 * by every control in the agent toolbar and chat composer, so button size,
 * rounding, and hover tint cannot drift per control. The icon is always
 * visible; `children` is the wide-container detail (current value, counters,
 * chevron) and folds away below the md container width — a narrow bar shows
 * icon-only controls on one row, a wide bar shows the detail. `min-w-6`
 * keeps the folded state an IconButton-sized 24px box instead of a cramped
 * glyph-width sliver.
 *
 * `label` is the accessible name; the hover bubble shows `title` when given,
 * else the label. The tooltip is fully CONTROLLED by this component
 * (hover-intent open, instant close on press or menu expansion): an
 * uncontrolled Radix tooltip trigger stacked under a menu trigger self-opens
 * on the focus that returns when the menu closes, and that interplay
 * dismissed a freshly reopened menu (2026-08-31 regression test). Under a
 * controlled root the Radix trigger listeners are inert and only anchor the
 * bubble. Font size is inherited so chat surfaces can scale it in em.
 * `onClick` may be omitted: wrapped in a Radix `asChild` trigger, the trigger
 * injects its handler and state props through `...rest`. */
export function ToolbarControl({
	label,
	icon,
	status,
	title,
	tone,
	className,
	detailClassName,
	tooltipContainer,
	reveal = 1,
	children,
	...rest
}: {
	/** Accessible name — rendered as `aria-label` and the default tooltip. */
	label: string;
	/** Always-visible glyph; size it explicitly (size-3.5 is the bar norm). */
	icon: React.ReactNode;
	/** Status signal (numeric summaries like diff counts) — unlike the
	 * detail, it NEVER folds: change is first-class information, and folding
	 * the W/↓ counters away in a narrow bar hid real state (2026-08-31). */
	status?: React.ReactNode;
	/** Richer tooltip text when the visible detail needs more context. */
	title?: string;
	tone?: "danger";
	className?: string;
	/** Extra classes for the collapsing detail span (truncation, width caps). */
	detailClassName?: string;
	/** Secondary-window triggers keep their explanation beside their content. */
	tooltipContainer?: HTMLElement;
	/** Which width step unfolds this control's detail — lower unfolds first. */
	reveal?: ToolbarControlReveal;
	children?: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title" | "className">) {
	const [tipOpen, setTipOpen] = React.useState(false);
	const openTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const clearOpenTimer = () => {
		if (openTimer.current !== undefined) clearTimeout(openTimer.current);
		openTimer.current = undefined;
	};
	React.useEffect(() => clearOpenTimer, []);
	const hide = () => {
		clearOpenTimer();
		setTipOpen(false);
	};
	// A menu trigger injects aria-expanded; the bubble yields to the open menu.
	const expanded = rest["aria-expanded"] === true;

	return (
		<Tooltip open={tipOpen && !expanded}>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					// Blocks ancestor native titles (the toolbar frame's right-click
					// fork hint) from stacking a second, browser-delayed tooltip on
					// top of the Radix bubble (2026-08-31 double-tooltip report).
					title=""
					className={cn(
						"flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[0.85em] text-muted-foreground outline-none transition-colors hover:bg-glass-tint-hover hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
						tone === "danger" && "text-destructive hover:text-destructive",
						className,
					)}
					{...rest}
					onPointerEnter={composeHandlers(rest.onPointerEnter, () => {
						clearOpenTimer();
						openTimer.current = setTimeout(
							() => setTipOpen(true),
							TOOLTIP_OPEN_DELAY_MS,
						);
					})}
					onPointerLeave={composeHandlers(rest.onPointerLeave, hide)}
					onPointerDown={composeHandlers(rest.onPointerDown, hide)}
				>
					{icon}
					{status != null && (
						<span className="flex shrink-0 items-center gap-1">{status}</span>
					)}
					{children != null && (
						<span
							className={cn(
								"flex min-w-0 items-center gap-1",
								DETAIL_REVEAL[reveal],
								detailClassName,
							)}
						>
							{children}
						</span>
					)}
				</button>
			</TooltipTrigger>
			<TooltipContent container={tooltipContainer}>{title ?? label}</TooltipContent>
		</Tooltip>
	);
}
