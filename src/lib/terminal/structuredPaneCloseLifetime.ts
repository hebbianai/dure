import type { IDockviewPanelProps } from "dockview-react";
import { readDesktopCloseIntent } from "@/lib/workspace/desktop/desktopCloseIntent";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { observeCloseIntent } from "@/lib/workspace/layout/closeIntentObservers";
import {
	exactLayoutRevision,
	matchesExactPaneBinding,
} from "@/lib/workspace/layout/layoutCloseIdentity";
import { readPaneCloseIntent } from "@/lib/workspace/pane/paneCloseIntent";
import { useStore } from "@/store";
import type { HmuxPaneBindingV1 } from "./terminalBinding";

/** Binds one rendered attachment to its existing, exact Dockview close journal. */
export function observeStructuredPaneClose({
	desktopId,
	paneApi,
	binding,
	retire,
	resume,
}: {
	desktopId?: string;
	paneApi?: IDockviewPanelProps["api"];
	binding: HmuxPaneBindingV1;
	retire: () => Promise<void>;
	resume: () => void;
}): () => void {
	if (!desktopId || !paneApi) return () => {};
	let retirement: Promise<void> | undefined;
	const observe = () => {
		const panel = getDockview(desktopId)?.getPanel(paneApi.id);
		if (
			panel?.api !== paneApi ||
			exactLayoutRevision(panel.params?.binding) !==
				exactLayoutRevision(binding)
		)
			return;
		const pane = readPaneCloseIntent(desktopId, paneApi.id);
		const desktop = readDesktopCloseIntent(desktopId)?.expectedPanes.find(
			(pane) => pane.panelId === paneApi.id,
		);
		const closing =
			(pane &&
				pane.phase !== "prepared" &&
				matchesExactPaneBinding(panel.params, pane.expectedBinding)) ||
			(desktop &&
				(desktop.departureState === "started" ||
					desktop.departureState === "processed") &&
				matchesExactPaneBinding(panel.params, desktop.binding));
		if (closing) {
			retirement ??= retire();
			return retirement;
		}
		if (
			retirement &&
			useStore.getState().spaces.some((space) => space.id === desktopId)
		) {
			// The close CAS preserved this mounted generation. Its old observer stays
			// retired; React creates a fresh lifetime using the normal attachment path.
			retirement = undefined;
			resume();
		}
	};
	const dispose = observeCloseIntent(desktopId, observe);
	void observe()?.catch((error) => {
		console.warn("[workspace] late closed attachment retirement failed", error);
	});
	return dispose;
}
