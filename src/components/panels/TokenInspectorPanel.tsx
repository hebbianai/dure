import type { IDockviewPanelProps } from "dockview-react";
import { Save, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Titled } from "@/components/ui/tooltip";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { RefreshButton } from "@/components/ui/refresh-button";
import { LoadingStatus, PanelStatus } from "@/components/common/PanelStatus";
import {
	applyInspectorPreview,
	buildInspectorPreviewCss,
	effectiveTokenValue,
	formatOklch,
	INSPECTOR_PREVIEW_STYLE_ID,
	isRuntimeToken,
	parseSliderColor,
	parseTokenSnapshot,
	sliderTrackStops,
	TOKEN_SNAPSHOT_RELATIVE_PATH,
	type TokenSnapshot,
} from "@/lib/design/tokenInspector";
import { t } from "@/lib/i18n";
import { readFile } from "@/lib/ipc/files";
import { ThemeIdCollisionError, UI_TOKEN_ALLOWLIST } from "@/lib/theme/themeDefinition";
import { type Oklch, oklchToHex } from "@/lib/theme/oklch";
import { useActiveTerminalPalette, useResolvedDark } from "@/lib/theme/themePreference";
import { showErrorToast, showToast } from "@/lib/toast";
import { useStore } from "@/store";

const ALLOWLISTED = new Set<string>(UI_TOKEN_ALLOWLIST);

/** Edited value → #rrggbb for ThemeDefinition.ui (its validator is hex-only). */
function toThemeHex(value: string): string | null {
	if (/^#[0-9a-fA-F]{6}$/.test(value.trim())) return value.trim();
	const oklch = parseSliderColor(value);
	return oklch ? oklchToHex(oklch) : null;
}

function ChannelSlider({
	label,
	value,
	max,
	step,
	base,
	channel,
	onChange,
}: {
	label: string;
	value: number;
	max: number;
	step: number;
	base: Oklch;
	channel: "l" | "c" | "h";
	onChange: (next: number) => void;
}) {
	const gradient = `linear-gradient(to right, ${sliderTrackStops(base, channel).join(", ")})`;
	return (
		<label className="flex items-center gap-2 text-[11px] text-muted-foreground">
			<span className="w-3 font-mono">{label}</span>
			<input
				type="range"
				min={0}
				max={max}
				step={step}
				value={value}
				style={{ background: gradient }}
				className="h-2 flex-1 cursor-pointer appearance-none rounded-full"
				onChange={(e) => onChange(Number(e.target.value))}
			/>
			<span className="w-12 text-right font-mono">{channel === "h" ? value.toFixed(0) : value.toFixed(3)}</span>
		</label>
	);
}

function TokenEditor({
	baseValue,
	edited,
	onEdit,
}: {
	/** the value the app currently shows in this appearance (dark-aware) */
	baseValue: string;
	edited: string | undefined;
	onEdit: (value: string | null) => void;
}) {
	const current = edited ?? baseValue;
	const oklch = parseSliderColor(current);
	return (
		<div className="flex flex-col gap-1.5 py-2 pl-6">
			{oklch ? (
				<>
					<ChannelSlider label="L" value={oklch.l} max={1} step={0.001} base={oklch} channel="l" onChange={(l) => onEdit(formatOklch({ ...oklch, l }))} />
					<ChannelSlider label="C" value={oklch.c} max={0.4} step={0.001} base={oklch} channel="c" onChange={(c) => onEdit(formatOklch({ ...oklch, c }))} />
					<ChannelSlider label="H" value={oklch.h} max={360} step={1} base={oklch} channel="h" onChange={(h) => onEdit(formatOklch({ ...oklch, h }))} />
				</>
			) : (
				<Input
					className="font-mono"
					value={current}
					onChange={(e) => onEdit(e.target.value)}
				/>
			)}
			{edited !== undefined ? (
				<Button
					type="button"
					size="xs"
					variant="outline"
					className="self-start"
					onClick={() => onEdit(null)}
				>
					{t("panels.tokens.revertToken")}
				</Button>
			) : null}
		</div>
	);
}

/** Direct-manipulation token editing with instant whole-app preview.
 *  Schema comes from the coverage envelope; edits preview via a dedicated
 *  style layer and save as a custom theme scheme. */
export function TokenInspectorPanel(props: IDockviewPanelProps) {
	const focusCtx = useStore((s) => s.focusCtx);
	const addCustomTheme = useStore((s) => s.addCustomTheme);
	const isDark = useResolvedDark();
	const activeTerminal = useActiveTerminalPalette();
	const previewId = `${INSPECTOR_PREVIEW_STYLE_ID}-${useId()}`;
	const [snapshot, setSnapshot] = useState<TokenSnapshot | "loading" | "no-folder" | "missing">(
		"loading",
	);
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<string | null>(null);
	const [edits, setEdits] = useState<Record<string, string>>({});
	const [themeName, setThemeName] = useState("");
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (focusCtx?.source !== "local" || !focusCtx.cwd) {
				setSnapshot("no-folder");
				return;
			}
			setSnapshot("loading");
			// The focus context may be a terminal deep inside the repo (live
			// OSC7 cwd) — walk up toward the repository root before declaring
			// the snapshot missing.
			let dir = focusCtx.cwd;
			for (let depth = 0; depth < 12 && dir && dir !== "/"; depth++) {
				try {
					const file = await readFile(`${dir}/${TOKEN_SNAPSHOT_RELATIVE_PATH}`);
					if (cancelled) return;
					if (file.kind === "text") {
						setSnapshot(parseTokenSnapshot(file.content));
						return;
					}
				} catch {
					// keep walking up
				}
				dir = dir.replace(/\/[^/]*$/, "") || "/";
			}
			if (!cancelled) setSnapshot("missing");
		})();
		return () => {
			cancelled = true;
		};
	}, [focusCtx, nonce]);

	// Live preview: every edit swaps one style element's text — sub-ms, no HMR.
	// applyThemeStyle appends the managed override on creation (scheme
	// none→some), so the preview layer must reclaim the last slot when theme
	// inputs change — a store subscription re-appends without re-rendering.
	useEffect(() => {
		const reapply = () =>
			applyInspectorPreview(document, buildInspectorPreviewCss(edits), previewId);
		reapply();
		const unsubscribe = useStore.subscribe((state, previous) => {
			if (
				state.uiPrefs?.themeScheme !== previous.uiPrefs?.themeScheme ||
				state.customThemes !== previous.customThemes
			) {
				reapply();
			}
		});
		return () => {
			unsubscribe();
			applyInspectorPreview(document, "", previewId);
		};
	}, [edits, previewId]);

	const rows = useMemo(() => {
		if (typeof snapshot === "string" || !snapshot.ok) return [];
		const needle = query.trim().toLowerCase();
		return needle
			? snapshot.tokens.filter((row) => row.name.toLowerCase().includes(needle))
			: snapshot.tokens;
	}, [snapshot, query]);

	const editedCount = Object.keys(edits).length;

	const saveAsTheme = () => {
		const ui: Record<string, string> = {};
		// Seed every allowlisted token with the value the app currently shows —
		// otherwise resolveTheme derives the un-edited ones from the terminal
		// palette and the applied theme drifts from what was previewed.
		if (typeof snapshot !== "string" && snapshot.ok) {
			for (const row of snapshot.tokens) {
				const bare = row.name.replace(/^--/, "");
				if (!ALLOWLISTED.has(bare)) continue;
				const hex = toThemeHex(effectiveTokenValue(row, isDark));
				if (hex) ui[bare] = hex;
			}
		}
		const skipped: string[] = [];
		for (const [name, value] of Object.entries(edits)) {
			const bare = name.replace(/^--/, "");
			const hex = toThemeHex(value);
			if (ALLOWLISTED.has(bare) && hex) ui[bare] = hex;
			else skipped.push(name);
		}
		if (skipped.length === Object.keys(edits).length) {
			showErrorToast(t("panels.tokens.theme.noSavableEdits"), { paneId: props.api.id });
			return;
		}
		const name = themeName.trim() || `Inspector ${new Date().toISOString().slice(0, 10)}`;
		const id = `inspector-${Date.now().toString(36)}`;
		try {
			addCustomTheme({
				id,
				name,
				appearance: isDark ? "dark" : "light",
				// The active scheme's palette, not the default — the saved theme
				// must reproduce what the designer is looking at.
				terminal: activeTerminal,
				ui,
			});
			showToast(
				skipped.length > 0
					? t("panels.tokens.theme.savedWithExclusions", { names: skipped.join(", ") })
					: t("panels.tokens.theme.saved"),
				{ paneId: props.api.id },
			);
		} catch (cause) {
			showErrorToast(
				cause instanceof ThemeIdCollisionError ? t("panels.tokens.theme.nameExists") : String(cause),
				{ paneId: props.api.id },
			);
		}
	};

	if (snapshot === "loading") {
		return (
			<LoadingStatus size="sm" className="bg-background" />
		);
	}
	if (snapshot === "no-folder" || snapshot === "missing" || !snapshot.ok) {
		return (
			<PanelStatus className="bg-background p-6 text-center">
				<p>
					{snapshot === "no-folder"
						? t("panels.tokens.snapshot.selectFolderFirst")
						: t("panels.tokens.snapshot.missingOrOutdated")}
				</p>
				<p className="font-mono text-xs">pnpm design:coverage</p>
				<Button
					type="button"
					size="xs"
					variant="outline"
					onClick={() => setNonce((n) => n + 1)}
				>
					{t("panels.tokens.reload")}
				</Button>
			</PanelStatus>
		);
	}

	return (
		<div data-pane-surface="own" className="flex h-full min-h-0 flex-col bg-surface-background">
			<div className="flex items-center gap-2 border-b border-border px-3 py-2">
				<SearchField
					placeholder={t("panels.tokens.searchPlaceholder")}
					className="min-w-0 flex-1"
					inputClassName="h-8 min-w-0"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
					{rows.length}/{snapshot.tokens.length}
				</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{rows.map((row) => {
					const edited = edits[row.name];
					const baseValue = effectiveTokenValue(row, isDark);
					const shown = edited ?? baseValue;
					const swatch = parseSliderColor(shown);
					const runtime = isRuntimeToken(row);
					return (
						<div key={row.name} className="border-b border-border/50">
							<button
								type="button"
								className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/50"
								onClick={() => setExpanded((v) => (v === row.name ? null : row.name))}
							>
								{swatch ? (
									<span
										className="h-3.5 w-3.5 shrink-0 rounded-full border border-border"
										style={{ background: oklchToHex(swatch) }}
									/>
								) : (
									<span className="h-3.5 w-3.5 shrink-0 rounded-full border border-dashed border-border" />
								)}
								<span className="min-w-0 flex-1 truncate text-xs">{row.name}</span>
								{edited !== undefined ? <span className="text-[10px] text-muted-foreground">{t("panels.tokens.edited")}</span> : null}
								{!runtime ? (
									// Build-time (@theme) tokens cannot preview sub-ms — say so honestly.
									<Titled title={t("panels.tokens.buildTimeHint")}>
										<span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
											{t("panels.tokens.buildBadge")}
										</span>
									</Titled>
								) : null}
								<span className="max-w-40 truncate font-mono text-[11px] text-muted-foreground">{shown}</span>
							</button>
							{expanded === row.name ? (
								<TokenEditor
									baseValue={baseValue}
									edited={edited}
									onEdit={(value) =>
										setEdits((prev) => {
											const next = { ...prev };
											if (value === null || value === baseValue) delete next[row.name];
											else next[row.name] = value;
											return next;
										})
									}
								/>
							) : null}
						</div>
					);
				})}
			</div>
			<div className="flex items-center gap-2 border-t border-border px-3 py-2">
				<span className="text-[11px] text-muted-foreground">
					{editedCount > 0 ? t("panels.tokens.editingCount", { n: editedCount }) : t("panels.tokens.rowEditHint")}
				</span>
				<Titled title={t("panels.tokens.snapshot.generatedAtHint")}>
					<span
						className="font-mono text-[10px] text-muted-foreground/70"
					>
						{snapshot.generatedAt.slice(0, 16).replace("T", " ")} · {snapshot.sourceCommit.slice(0, 8)}
					</span>
				</Titled>
				<span className="flex-1" />
				{editedCount > 0 ? (
					<>
						<Input
							placeholder={t("panels.tokens.theme.namePlaceholder")}
							className="w-32"
							value={themeName}
							onChange={(e) => setThemeName(e.target.value)}
						/>
						<Button
							type="button"
							size="xs"
							variant="outline"
							title={t("panels.tokens.theme.saveEditsHint")}
							onClick={saveAsTheme}
						>
							<Save /> {t("panels.tokens.theme.saveAs")}
						</Button>
						<IconButton
							title={t("panels.tokens.revertAll")}
							onClick={() => setEdits({})}
						>
							<X />
						</IconButton>
					</>
				) : (
					<RefreshButton
						title={t("panels.tokens.reload")}
						onClick={() => setNonce((n) => n + 1)}
					/>
				)}
			</div>
		</div>
	);
}
