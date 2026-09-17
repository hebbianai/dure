import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { type HTMLAttributes, type ReactNode, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type SessionListRowStatusTone =
	| "attention"
	| "danger"
	| "muted"
	| "neutral";

// Glass v2 §1 D: no filled badge on glass. Every tone here carried one, and
// the fill said nothing the word beside it did not — colour alone still
// separates a warning from a note, which is the one place this app spends
// colour (2026-09-04 dropped these fills in the plugins pane and the commit
// graph; this list was missed).
const STATUS_TONE: Record<SessionListRowStatusTone, string> = {
	attention: "text-status-warn",
	danger: "text-destructive",
	muted: "text-muted-foreground",
	neutral: "text-muted-foreground",
};

export function SessionStatusBadge({
	status,
	description,
	tone = "neutral",
}: {
	status: string;
	description?: string;
	tone?: SessionListRowStatusTone;
}) {
	const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
	const badge = (
		<Badge
			asChild={Boolean(description)}
			variant="secondary"
			size="sm"
			className={cn(
				"h-auto shrink-0 border-0 bg-transparent p-0 text-meta leading-none font-normal",
				STATUS_TONE[tone],
			)}
		>
			{description ? (
				<button type="button" ref={setTrigger}>
					{status}
				</button>
			) : (
				status
			)}
		</Badge>
	);
	if (!description) return badge;
	return (
		<Tooltip>
			<TooltipTrigger asChild>{badge}</TooltipTrigger>
			<TooltipContent
				container={trigger?.ownerDocument.body}
				description={description}
			>
				{status}
			</TooltipContent>
		</Tooltip>
	);
}

export function SessionListRow({
	icon,
	name,
	metadata,
	detail,
	status,
	statusTone = "neutral",
	statusDescription,
	menu,
	menuOpen = false,
	busy = false,
	activateLabel,
	onActivate,
	className,
	...rest
}: {
	icon: ReactNode;
	name: string;
	metadata?: string;
	detail?: string;
	status?: string;
	statusTone?: SessionListRowStatusTone;
	statusDescription?: string;
	menu?: ReactNode;
	menuOpen?: boolean;
	busy?: boolean;
	activateLabel?: string;
	onActivate?: () => void;
} & Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick">) {
	return (
		<div
			{...rest}
			className={cn(
				"group/item flex min-w-0 items-center gap-2 rounded-md px-2 py-2",
				onActivate &&
					"cursor-pointer hover:bg-glass-tint-hover focus-visible:outline-none focus-visible:inset-ring-1 focus-visible:inset-ring-ring",
				menuOpen && "bg-glass-tint-selected",
				busy && "pointer-events-none opacity-55",
				className,
			)}
			role={onActivate ? "button" : undefined}
			tabIndex={onActivate ? 0 : undefined}
			aria-label={onActivate ? activateLabel : undefined}
			aria-disabled={busy || undefined}
			onClick={(event) => {
				if (!onActivate || busy) return;
				if ((event.target as HTMLElement).closest("button,[role='menuitem']")) {
					return;
				}
				onActivate();
			}}
			onKeyDown={(event) => {
				if (
					!onActivate ||
					busy ||
					event.target !== event.currentTarget ||
					(event.key !== "Enter" && event.key !== " ")
				) {
					return;
				}
				event.preventDefault();
				onActivate();
			}}
		>
			{/* A bare 14px glyph, like every other row in this sidebar. It used to
			    sit in a filled 20px chip, which nothing else here does — a chip
			    says "this is a thing you can act on", and the row already is one
			    (owner request 2026-09-08). */}
			<span className="flex shrink-0 items-center self-start text-muted-foreground [&_svg]:size-3.5">
				{icon}
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex min-w-0 items-center gap-1.5">
					<OverflowRevealText text={name}
						className="min-w-0 flex-1 text-xs font-medium text-sidebar-foreground" />
					{status && (
						<SessionStatusBadge
							status={status}
							tone={statusTone}
							description={statusDescription}
						/>
					)}
				</span>
				{/* Both sub-lines on `text-meta` (11px), the smallest size this app
				    has. They were 10px and 9px — below every token in the type
				    scale, and the 9px line was smaller than anything else in the
				    product. What separates them now is tone, not size. The 6px
				    gap is the one every two-line row in the sidebar uses. */}
				{metadata && (
					<OverflowRevealText text={metadata}
						className="mt-1.5 block min-w-0 font-mono text-meta leading-none text-muted-foreground" />
				)}
				{detail && (
					<OverflowRevealText text={detail}
						className="mt-1.5 block min-w-0 text-meta leading-none text-muted-foreground/70" />
				)}
			</span>
			{menu && (
				<span
					className={cn(
						String.raw`shrink-0 opacity-0 transition-opacity [.group\/item:focus-within_:where(&)]:opacity-100 group-hover/item:opacity-100`,
						menuOpen && "opacity-100",
					)}
				>
					{menu}
				</span>
			)}
		</div>
	);
}
