import { Popover } from "radix-ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { AgentRow } from "@/components/agents/AgentRow";
import {
	type AgentRowPlacement,
	useAgentRowFacts,
} from "@/components/agents/useAgentRowFacts";
import {
	useNextUp,
	useNextUpKeys,
	useNextUpShortcut,
	useNextUpSpaceNames,
} from "@/components/agents/useNextUp";
import { Kbd } from "@/components/ui/kbd";
import { Titled } from "@/components/ui/tooltip";
import { agentRowModel } from "@/lib/agents/agentRowModel";
import type { NextUp, NextUpEntry } from "@/lib/agents/nextUp";
import { revealAgent } from "@/lib/agents/nextUpNavigation";
import { t } from "@/lib/i18n";
import { MENU_GLASS_FILL_CLASS, MENU_SIDE_OFFSET } from "@/lib/ui/menuSurface";
import { keepPointerOpenFocusOnSurface } from "@/lib/ui/pointerOpenFocus";
import { cn } from "@/lib/utils";
import { isMainWindow } from "@/lib/workspace/window/windows";

const SECTIONS = [
	{ key: "needsYou", heading: () => t("agents.nextUp.needsYou") },
	{ key: "results", heading: () => t("agents.nextUp.results") },
] as const;

/** Which agent needs the person next, across every Space. It belongs to the
 * main window, the one that owns attention notifications: other windows keep
 * their own acknowledgements and observe no Host semantics of their own. */
export function NextUpChip() {
	return isMainWindow() ? <MainWindowNextUp /> : null;
}

/** Draws nothing while nothing is waiting; the attention tone is spent only
 * while a human is blocking work, and results stay quiet. */
function MainWindowNextUp() {
	const nextUp = useNextUp();
	useNextUpShortcut();
	const keys = useNextUpKeys();
	const [open, setOpen] = useState(false);
	// A row hands focus to its pane; returning it to the chip would undo that.
	const selected = useRef(false);
	const needsYou = nextUp.needsYou.length;
	const results = nextUp.results.length;
	useEffect(() => {
		if (needsYou + results === 0) setOpen(false);
	}, [needsYou, results]);
	if (needsYou + results === 0) return null;

	const [heading, count] =
		needsYou > 0
			? [t("agents.nextUp.needsYou"), needsYou]
			: [t("agents.nextUp.results"), results];
	const select = (agentId: string) => {
		selected.current = true;
		setOpen(false);
		revealAgent(agentId);
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Titled title={t("agents.nextUp.open")}>
				<Popover.Trigger asChild>
					<button
						type="button"
						data-slot="next-up-chip"
						data-tone={needsYou > 0 ? "attention" : "quiet"}
						className={cn(
							"inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-meta leading-none outline-none transition-colors hover:bg-glass-tint-hover focus-visible:ring-1 focus-visible:ring-ring",
							needsYou > 0 ? "text-foreground" : "text-muted-foreground",
						)}
						aria-label={`${t("agents.nextUp.open")} · ${heading} ${count}`}
					>
						<span
							aria-hidden="true"
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								needsYou > 0 ? "bg-status-blocked" : "bg-muted-foreground/60",
							)}
						/>
						{heading}
						<span className="tabular-nums">{count}</span>
					</button>
				</Popover.Trigger>
			</Titled>
			<Popover.Portal>
				<Popover.Content
					data-slot="next-up-list"
					aria-label={t("agents.nextUp.title")}
					side="bottom"
					align="end"
					sideOffset={MENU_SIDE_OFFSET}
					collisionPadding={8}
					onOpenAutoFocus={keepPointerOpenFocusOnSurface}
					onCloseAutoFocus={(event) => {
						if (selected.current) event.preventDefault();
						selected.current = false;
					}}
					// The menu layer's glass, like the usage popover beside it; rows
					// stay text on a readable tint, never over a pane's output.
					className={cn(
						MENU_GLASS_FILL_CLASS,
						"z-50 flex max-h-[min(480px,calc(100vh-64px))] w-80 max-w-[calc(100vw-16px)] origin-(--radix-popover-content-transform-origin) flex-col rounded-lg p-1 text-foreground shadow-menu inset-ring-1 inset-ring-glass-menu-hairline outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 motion-reduce:animate-none motion-reduce:transform-none motion-reduce:duration-0",
					)}
				>
					<NextUpList nextUp={nextUp} onSelect={select} />
					{keys.length > 0 && (
						<div className="flex shrink-0 items-center justify-between gap-3 border-t border-glass-menu-hairline px-2 pt-2 pb-1 text-meta text-muted-foreground">
							<span className="min-w-0 truncate">
								{t("settings.shortcuts.cmd.goToNextUp")}
							</span>
							<span className="flex shrink-0 items-center gap-0.5">
								{keys.map((key) => (
									<Kbd key={key} size="sm">
										{key}
									</Kbd>
								))}
							</span>
						</div>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

function NextUpList({
	nextUp,
	onSelect,
}: {
	nextUp: NextUp;
	onSelect: (agentId: string) => void;
}) {
	const spaceNames = useNextUpSpaceNames(nextUp);
	return (
		<div className="min-h-0 overflow-y-auto">
			{SECTIONS.map(({ key, heading }) =>
				nextUp[key].length === 0 ? null : (
					<NextUpSection key={key} heading={heading()}>
						{nextUp[key].map((entry) => (
							<NextUpRow
								key={entry.agentId}
								entry={entry}
								spaceName={spaceNames.get(entry.agentId)}
								onSelect={onSelect}
							/>
						))}
					</NextUpSection>
				),
			)}
		</div>
	);
}

function NextUpSection({
	heading,
	children,
}: {
	heading: string;
	children: ReactNode;
}) {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="pb-1">
			<h3
				id={headingId}
				className="flex h-7 items-center px-2 text-meta font-medium text-muted-foreground"
			>
				{heading}
			</h3>
			<ul>{children}</ul>
		</section>
	);
}

/** Where a Next up entry stands, for its row: why it is listed and since
 * when, in the needs-person and has-result vocabulary every row shares. */
function nextUpPlacement(
	entry: NextUpEntry,
	spaceName: string | undefined,
): AgentRowPlacement {
	return {
		state: entry.state,
		...(entry.reason === "result"
			? { hasResult: true }
			: {
					needsPerson: {
						reason: entry.reason,
						...(entry.signIn ? { signIn: entry.signIn } : {}),
					},
				}),
		...(entry.sinceMs === undefined ? {} : { sinceMs: entry.sinceMs }),
		...(spaceName ? { spaceName } : {}),
	};
}

function NextUpRow({
	entry,
	spaceName,
	onSelect,
}: {
	entry: NextUpEntry;
	spaceName: string | undefined;
	onSelect: (agentId: string) => void;
}) {
	const facts = useAgentRowFacts(entry.agentId, nextUpPlacement(entry, spaceName));
	if (!facts) return null;
	return (
		<li>
			<AgentRow row={agentRowModel(facts)} onSelect={onSelect} />
		</li>
	);
}
