import { useRef, useState } from "react";
import { ProviderGlyph, TerminalGlyph } from "@/components/agents/ProviderLogo";
import { Titled } from "@/components/ui/tooltip";
import { SearchField } from "@/components/ui/search-field";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ProviderLaunchRow } from "@/lib/workspace/emptySpaceLauncher";
import type { Provider } from "@/types";

const ROW_CLASS =
	"flex w-full min-w-0 items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors enabled:hover:bg-accent disabled:aria-[busy=false]:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The same catalog, command previews and keyboard interaction in both launch surfaces. */
export function PaneLaunchChoices({
	rows,
	onTerminal,
	onAgent,
	opening,
}: {
	rows: readonly ProviderLaunchRow[];
	onTerminal: () => void;
	onAgent: (provider: Provider) => void;
	opening?: "terminal" | Provider | null;
}) {
	const [query, setQuery] = useState("");
	const listRef = useRef<HTMLDivElement>(null);
	const needle = query.trim().toLocaleLowerCase();
	const visible = rows.filter((row) =>
		`${row.provider} ${row.command}`.toLocaleLowerCase().includes(needle),
	);
	const showTerminal =
		t("common.terminal").toLocaleLowerCase().includes(needle) ||
		"terminal".includes(needle);
	const moveFocus = (event: React.KeyboardEvent) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const buttons = [
			...(listRef.current?.querySelectorAll<HTMLButtonElement>(
				"[data-launcher-row]",
			) ?? []),
		];
		if (!buttons.length) return;
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		buttons[
			event.key === "ArrowDown"
				? Math.min(index + 1, buttons.length - 1)
				: Math.max(index - 1, 0)
		]?.focus();
		event.preventDefault();
	};
	return (
		<div className="mt-3 flex min-h-0 w-full flex-col" onKeyDown={moveFocus}>
			<SearchField
				type="search"
				aria-label={t("workspace.launcher.search")}
				placeholder={t("workspace.launcher.search")}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				onClear={() => setQuery("")}
				inputClassName="h-8"
				disabled={!!opening}
			/>
			<div ref={listRef} className="mt-2 min-h-0 overflow-y-auto">
				{showTerminal && (
					<button
						data-launcher-row
						type="button"
						className={ROW_CLASS}
						onClick={onTerminal}
						disabled={!!opening}
						aria-busy={opening === "terminal"}
					>
						<TerminalGlyph className="size-4 shrink-0 text-muted-foreground" />
						<span className="truncate text-sm text-foreground">
							{t("common.terminal")}
						</span>
						{opening === "terminal" && (
							<span
								role="status"
								className="ml-auto shrink-0 text-xs text-foreground"
							>
								{t("common.opening")}
							</span>
						)}
					</button>
				)}
				{visible.map((row) => (
					<Titled key={row.provider} title={row.command}>
						<button
							data-launcher-row
							type="button"
							className={ROW_CLASS}
							onClick={() => onAgent(row.provider)}
							disabled={!!opening}
							aria-busy={opening === row.provider}
						>
							<ProviderGlyph
								provider={row.provider}
								className="size-4 shrink-0"
							/>
							<span
								className={cn(
									"truncate font-mono text-[13px]",
									row.installed ? "text-foreground" : "text-muted-foreground",
								)}
							>
								{row.command}
							</span>
							{opening === row.provider && (
								<span
									role="status"
									className="ml-auto shrink-0 text-xs text-foreground"
								>
									{t("common.opening")}
								</span>
							)}
						</button>
					</Titled>
				))}
				{!showTerminal && !visible.length && (
					<p role="status" className="px-3 py-2 text-xs text-muted-foreground">
						{t("common.noResults")}
					</p>
				)}
			</div>
		</div>
	);
}
