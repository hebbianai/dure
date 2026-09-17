import { t } from "@/lib/i18n";

export type PaneDropIntent =
	| "none"
	| "float"
	| "insert-column"
	| "insert-row"
	| "split-left"
	| "split-right"
	| "split-top"
	| "split-bottom";

export interface PaneDropIntentSignals {
	insideWorkspace: boolean;
	insideSource: boolean;
	insertionOrientation: "HORIZONTAL" | "VERTICAL" | null;
	dockviewPosition: "left" | "right" | "top" | "bottom" | null;
}

/** Resolve one recommendation for a pane drag. More specific, executable
 * targets win over the workspace-level floating fallback. */
export function resolvePaneDropIntent(
	signals: PaneDropIntentSignals,
): PaneDropIntent {
	if (!signals.insideWorkspace || signals.insideSource) return "none";
	if (signals.insertionOrientation === "HORIZONTAL") return "insert-column";
	if (signals.insertionOrientation === "VERTICAL") return "insert-row";
	if (signals.dockviewPosition) return `split-${signals.dockviewPosition}`;
	return "float";
}

// Labels resolve through t() only when invoked, so the live language applies
// at the display boundary rather than at module evaluation.
const LABELS: Partial<Record<PaneDropIntent, () => string>> = {
	float: () => t("workspace.paneDrop.floatHint"),
	"insert-column": () => t("workspace.paneDrop.insertColumn"),
	"insert-row": () => t("workspace.paneDrop.insertRow"),
	"split-left": () => t("workspace.paneDrop.splitLeft"),
	"split-right": () => t("common.splitRight"),
	"split-top": () => t("workspace.paneDrop.splitUp"),
	"split-bottom": () => t("common.splitDown"),
};

/** Translated label for a drop intent — call at render/overlay time. */
export function paneDropIntentLabel(intent: PaneDropIntent): string | null {
	return LABELS[intent]?.() ?? null;
}
