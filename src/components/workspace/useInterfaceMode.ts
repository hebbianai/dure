import { basicFoldedSettingsPages } from "@/components/settings/settingsNav";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import {
	type InterfaceMode,
	resolveEffectiveInterfaceMode,
} from "@/lib/workspace/pane/interfaceMode";
import { useStore } from "@/store";

/** The one read point for the basic|pro interface mode outside the agent
 * toolbar projection — sidebar and pane surfaces that fold away in basic
 * mode all resolve the same stored preference and build policy here. */
export function useInterfaceMode(): InterfaceMode {
	return useStore(
		(state) => resolveEffectiveInterfaceMode(state.uiPrefs?.interfaceMode).mode,
	);
}

const NO_FOLDED_TABS: ReadonlySet<string> = new Set();
const BASIC_FOLDED_TABS: ReadonlySet<string> = new Set(["automations"]);

/** One resolver feeds rail visibility and effective selection. SSH, Sessions,
 * Source control, and Plugins stay reachable in every mode, including before
 * setup or while the plugin catalog is loading. Dure Tag stays reachable in Basic; Automations needs Beta. */
export function useBasicFoldedRailTabs(): ReadonlySet<string> {
	const mode = useInterfaceMode();
	return mode === "pro" ? NO_FOLDED_TABS : BASIC_FOLDED_TABS;
}

/** Sidebar tab with the basic-mode downgrade applied: a persisted selection
 * of a folded tab reads as "spaces" — the stored value is untouched and
 * returns when the user switches back to pro. Rail and panel must both
 * consume this so the selected chip and the rendered panel cannot
 * disagree. */
export function useEffectiveSidebarTab(): string {
	const folded = useBasicFoldedRailTabs();
	const tab = useWindowSidebarStore((state) => state.tab);
	return folded.has(tab) ? "spaces" : tab;
}

const NO_FOLDED_PAGES: ReadonlySet<import("@/components/settings/settingsNav").PageId> =
	new Set();
const BASIC_FOLDED_PAGES = basicFoldedSettingsPages();

/** Basic folds advanced navigation, not core AI setup or page routing. */
export function useBasicFoldedSettingsPages(): ReadonlySet<
	import("@/components/settings/settingsNav").PageId
> {
	const mode = useInterfaceMode();
	return mode === "pro" ? NO_FOLDED_PAGES : BASIC_FOLDED_PAGES;
}
