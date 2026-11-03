// Maximize a pane over the whole layout and restore it (#392).
//
// Dockview owns the mechanics: maximizing hides every other grid group in
// place and restoring shows them again with their sizes. The state is
// presentation only — saved layouts drop it (persistedPaneLayout.ts) — so a
// reload opens the layout normally.
import type { DockviewApi, IDockviewPanel } from "dockview-react";

type MaximizeSurface = Pick<
	DockviewApi,
	"hasMaximizedGroup" | "exitMaximizedGroup"
>;

/** Restore the layout if a pane is maximized. Returns whether one was.
 *
 * Projection doubles (cross-window moves, tests) may lack the maximize
 * surface; they never have a maximized pane. */
export function restoreMaximizedPane(
	api: Partial<MaximizeSurface> | undefined,
): boolean {
	if (
		typeof api?.hasMaximizedGroup !== "function" ||
		!api.hasMaximizedGroup()
	) {
		return false;
	}
	api.exitMaximizedGroup?.();
	return true;
}

/** The Maximize / Restore toggle shared by the pane header and the shortcut.
 *
 * While any pane is maximized the toggle restores it: every other grid pane is
 * covered then, so the only reachable target is the maximized pane itself or a
 * floating pane above it. Otherwise it maximizes `panel` (the active pane by
 * default) and makes it active. Only grid panes can cover the layout. */
export function toggleMaximizedPane(
	api: DockviewApi,
	panel: IDockviewPanel | undefined = api.activePanel,
): boolean {
	if (restoreMaximizedPane(api)) return true;
	if (panel?.group.api.location.type !== "grid") return false;
	panel.api.setActive();
	panel.api.maximize();
	return panel.api.isMaximized();
}

/** Whether a listing should present this pane as shown in its layout. A
 * maximized pane only covers its neighbours: they are still open, not hidden
 * (panes the user hid keep their own hidden records). */
export function paneShownInLayout(
	api: Partial<Pick<DockviewApi, "hasMaximizedGroup">> | undefined,
	panel: { readonly api: { readonly isVisible: boolean } },
): boolean {
	return panel.api.isVisible || api?.hasMaximizedGroup?.() === true;
}

interface EscapeKey {
	readonly key: string;
	readonly target: EventTarget | null;
	readonly defaultPrevented: boolean;
	readonly isComposing?: boolean;
	readonly metaKey: boolean;
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly shiftKey: boolean;
}

/** Surfaces that own Esc themselves: terminals and agent TUIs, editors, and
 * open dialogs or menus. Text inputs are matched by element type below. */
const ESCAPE_OWNERS = [
	".xterm",
	"[data-terminal-surface-id]",
	".cm-editor",
	"[contenteditable]:not([contenteditable='false'])",
	"[role='dialog']",
	"[role='alertdialog']",
	"[role='menu']",
	"[role='listbox']",
].join(",");

/** Whether a plain Esc keydown may restore a maximized pane. Esc is never
 * taken from a terminal, agent TUI, editor or text input, nor from a layer
 * that already handled it (Radix dialogs and menus prevent the default when
 * they dismiss). */
export function escapeRestoresMaximizedPane(event: EscapeKey): boolean {
	if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) {
		return false;
	}
	if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
		return false;
	}
	const target = event.target;
	if (!(target instanceof Element)) return true;
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	) {
		return false;
	}
	return target.closest(ESCAPE_OWNERS) === null;
}
