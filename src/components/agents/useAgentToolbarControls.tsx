import { type ReactElement, type ReactNode, useCallback, useMemo } from "react";
import { AgentToolbarSlot } from "@/components/agents/AgentToolbarSlot";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { t } from "@/lib/i18n";
import { resolveEffectiveInterfaceMode } from "@/lib/workspace/pane/interfaceMode";
import {
	AGENT_TOOLBAR_CONTROLS,
	type AgentToolbarControlId,
	type AgentToolbarControlSignals,
	agentToolbarControlVisible,
	withAgentToolbarControlHidden,
} from "@/lib/workspace/pane/agentToolbarControls";
import { useStore } from "@/store";

const LABEL_KEY_BY_ID = new Map(
	AGENT_TOOLBAR_CONTROLS.map((control) => [control.id, control.labelKey]),
);

function agentToolbarControlLabel(id: AgentToolbarControlId): string {
	const key = LABEL_KEY_BY_ID.get(id);
	return key ? t(key) : id;
}

export interface AgentToolbarControlsProjection {
	visible: (
		id: AgentToolbarControlId,
		signals?: AgentToolbarControlSignals,
	) => boolean;
	hide: (id: AgentToolbarControlId) => void;
	/** Wraps a visible control in its right-click hide slot. */
	slot: (id: AgentToolbarControlId, node: ReactNode) => ReactNode;
}

/** Cluster wiring hook — the one store touchpoint for toolbar-control
 * visibility. Every surface (panel toolbars, chat composer pills) resolves
 * through the same lib resolver and writes hides through the same pref. */
export function useAgentToolbarControls(): AgentToolbarControlsProjection {
	const interfaceMode = useStore(
		(s) => resolveEffectiveInterfaceMode(s.uiPrefs?.interfaceMode).mode,
	);
	const hiddenToolbarControls = useStore(
		(s) => s.uiPrefs?.hiddenToolbarControls,
	);
	const visible = useCallback(
		(id: AgentToolbarControlId, signals?: AgentToolbarControlSignals) =>
			agentToolbarControlVisible(
				id,
				{ interfaceMode, hiddenToolbarControls },
				signals,
			),
		[interfaceMode, hiddenToolbarControls],
	);
	const hide = useCallback((id: AgentToolbarControlId) => {
		const state = useStore.getState();
		state.setUiPrefs({
			hiddenToolbarControls: withAgentToolbarControlHidden(
				state.uiPrefs?.hiddenToolbarControls,
				id,
			),
		});
	}, []);
	const slot = useCallback(
		(id: AgentToolbarControlId, node: ReactNode) => (
			<AgentToolbarSlot
				controlLabel={agentToolbarControlLabel(id)}
				onHide={() => hide(id)}
			>
				{node}
			</AgentToolbarSlot>
		),
		[hide],
	);
	return useMemo(() => ({ visible, hide, slot }), [visible, hide, slot]);
}

export interface AgentToolbarGroupPresentation<
	Id extends AgentToolbarControlId,
> {
	hidden: ReadonlySet<Id>;
	slot: (id: Id, node: ReactElement) => ReactNode;
}

/** Resolves a component-internal control group (launch pills, window
 * actions) into a hidden-set plus slot wrapper, so those components stay
 * store-free while every id still goes through the one resolver. */
export function useAgentToolbarGroupPresentation<
	Id extends AgentToolbarControlId,
>(
	ids: readonly Id[],
	signals?: Partial<Record<Id, AgentToolbarControlSignals>>,
): AgentToolbarGroupPresentation<Id> {
	const { visible, slot } = useAgentToolbarControls();
	// Recomputed per render on purpose: the set is a handful of booleans and
	// memoizing on a caller-fresh signals object would be false stability.
	const hidden = new Set<Id>();
	for (const id of ids) {
		if (!visible(id, signals?.[id])) hidden.add(id);
	}
	return { hidden, slot };
}

export type AgentLaunchControlsPresentation = AgentToolbarGroupPresentation<
	"launch-model" | "launch-effort" | "launch-permissions"
>;

const LAUNCH_CONTROL_IDS = [
	"launch-model",
	"launch-effort",
	"launch-permissions",
] as const;

/** Shared launch-pill gating for the panel toolbar and the chat composer.
 * Skip approvals remains an attention signal; the common resolver keeps
 * Permissions Pro-only without changing the selected runtime permissions. */
export function useAgentLaunchControlsPresentation(
	launch: AgentRuntimeLaunchSelectionView | undefined,
): AgentLaunchControlsPresentation {
	const permissionAttention =
		launch?.loaded === true && launch.permissionMode === "skip_permissions";
	return useAgentToolbarGroupPresentation(LAUNCH_CONTROL_IDS, {
		"launch-permissions": { mustShow: permissionAttention },
	});
}
