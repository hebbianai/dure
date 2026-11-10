import { ArrowDown, ArrowUp, CaseSensitive, Regex, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { SearchField } from "@/components/ui/search-field";
import {
	FindStep,
	type ViewportFrame,
} from "@/contracts/terminalStateProtocol";
import { t } from "@/lib/i18n";
import {
	type TerminalFindSummary,
	terminalFindBarKeyAction,
	terminalFindHighlightBoxes,
} from "@/lib/terminal/interaction/terminalFind";
import { cn } from "@/lib/utils";
import {
	type StructuredTerminalFind,
	TERMINAL_FIND_MAX_QUERY_LENGTH,
} from "./useStructuredTerminalFind";

function summaryText(summary: TerminalFindSummary): string {
	switch (summary.kind) {
		case "idle":
			return "";
		case "searching":
			return t("terminal.find.searching");
		case "unsupported":
			return t("terminal.find.unsupported");
		case "invalid":
			return t("terminal.find.invalidPattern");
		case "none":
			return summary.complete
				? t("terminal.find.noMatches")
				: t("terminal.find.noMatchesPartial");
		case "matched":
			return t(
				summary.complete ? "terminal.find.count" : "terminal.find.countPartial",
				{
					current: summary.current.toLocaleString(),
					total: summary.total.toLocaleString(),
				},
			);
	}
}

/** Find bar pinned to the pane's top edge while open. */
export function StructuredTerminalFindBar({
	find,
}: {
	find: StructuredTerminalFind;
}) {
	if (!find.open) return null;
	const unsupported = find.summary.kind === "unsupported";
	const matched = find.summary.kind === "matched";
	const status = summaryText(find.summary);
	return (
		<div
			role="search"
			aria-label={t("terminal.find.label")}
			data-testid="structured-terminal-find"
			className="absolute top-2 right-3 z-30 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-sm"
		>
			<SearchField
				ref={find.inputRef}
				className="w-48 min-w-0 shrink"
				inputClassName="h-7"
				value={find.query}
				placeholder={t("terminal.find.placeholder")}
				aria-label={t("terminal.find.label")}
				maxLength={TERMINAL_FIND_MAX_QUERY_LENGTH}
				disabled={unsupported}
				spellCheck={false}
				autoCapitalize="off"
				autoCorrect="off"
				onChange={(event) => find.setQuery(event.target.value)}
				onKeyDown={(event) => {
					const action = terminalFindBarKeyAction({
						key: event.key,
						shiftKey: event.shiftKey,
						isComposing: event.nativeEvent.isComposing,
					});
					if (action === null) return;
					event.preventDefault();
					event.stopPropagation();
					if (action === "close") find.close();
					else find.step(action === "older" ? FindStep.OLDER : FindStep.NEWER);
				}}
			/>
			<span
				aria-live="polite"
				data-testid="structured-terminal-find-status"
				className={cn(
					"min-w-0 px-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums",
					unsupported && "whitespace-normal",
				)}
			>
				{status}
			</span>
			<IconButton
				title={t("terminal.find.caseSensitive")}
				pressed={find.caseSensitive}
				disabled={unsupported}
				onClick={find.toggleCaseSensitive}
			>
				<CaseSensitive />
			</IconButton>
			<IconButton
				title={t("terminal.find.regex")}
				pressed={find.regex}
				disabled={unsupported}
				onClick={find.toggleRegex}
			>
				<Regex />
			</IconButton>
			<IconButton
				title={t("terminal.find.older")}
				disabled={!matched}
				onClick={() => find.step(FindStep.OLDER)}
			>
				<ArrowUp />
			</IconButton>
			<IconButton
				title={t("terminal.find.newer")}
				disabled={!matched}
				onClick={() => find.step(FindStep.NEWER)}
			>
				<ArrowDown />
			</IconButton>
			<IconButton title={t("terminal.find.close")} onClick={find.close}>
				<X />
			</IconButton>
		</div>
	);
}

/** The Host's match segments for the presented frame, over the painted grid. */
export function StructuredTerminalFindHighlights({
	frame,
	metrics,
}: {
	frame: ViewportFrame | null;
	metrics: { readonly cellWidth: number; readonly rowHeight: number } | null;
}) {
	const boxes = terminalFindHighlightBoxes(frame?.find, metrics);
	if (boxes.length === 0) return null;
	return (
		<div aria-hidden className="pointer-events-none absolute inset-0">
			{boxes.map((box) => (
				<div
					key={box.key}
					data-current={box.current || undefined}
					className={cn(
						"absolute rounded-[2px]",
						box.current
							? "bg-foreground/30 ring-1 ring-foreground/70"
							: "bg-foreground/15",
					)}
					style={{
						left: box.left,
						top: box.top,
						width: box.width,
						height: box.height,
					}}
				/>
			))}
		</div>
	);
}
