/**
 * Catalog and single resolver for agent pane-toolbar control visibility.
 *
 * Two layers, one authority (2026-08-31, approved design): the interface
 * mode (`basic` shows only tier-basic controls, `pro` shows all) is the
 * baseline, and an explicit per-control hidden list — written by the
 * toolbar's right-click "hide" — sits on top. Restoring a control deletes
 * its hidden entry so it falls back to whatever the mode says. Every
 * surface that renders one of these controls (panel toolbars, the chat
 * composer's launch pills) must gate through `agentToolbarControlVisible`
 * rather than re-deriving policy.
 *
 * The caller's `mustShow` attention signal (a credential switch pending or
 * failed, or skip approvals active) overrides hiding and usually the mode.
 * Permissions remains Pro-only even when skip approvals is active.
 */

import type { InterfaceMode } from "@/lib/workspace/pane/interfaceMode";

export type AgentToolbarControlId =
	| "account"
	| "launch-model"
	| "launch-effort"
	| "launch-permissions"
	| "view-switch"
	| "diff-window"
	| "source-control-window"
	| "conversation-history";

export interface AgentToolbarControlDescriptorV1 {
	readonly id: AgentToolbarControlId;
	/** Lowest interface mode that shows the control by default. */
	readonly tier: InterfaceMode;
	/** i18n key for a short neutral control name (hide menu, restore list). */
	readonly labelKey: string;
}

export const AGENT_TOOLBAR_CONTROLS: readonly AgentToolbarControlDescriptorV1[] =
	[
		// 2026-08-31 owner call: surface switching is itself a pro concept —
		// basic users stay on the surface the agent opened with.
		{ id: "view-switch", tier: "pro", labelKey: "agents.runtime.viewLabel" },
		{
			id: "diff-window",
			tier: "basic",
			labelKey: "panels.agent.toolbar.control.diffWindow",
		},
		{
			id: "source-control-window",
			tier: "basic",
			labelKey: "panels.agent.toolbar.control.sourceControlWindow",
		},
		{
			id: "conversation-history",
			tier: "basic",
			labelKey: "panels.agent.toolbar.control.conversationHistory",
		},
		{ id: "account", tier: "basic", labelKey: "common.paneAccount" },
		{ id: "launch-model", tier: "pro", labelKey: "agents.chat.modelLabel" },
		{ id: "launch-effort", tier: "pro", labelKey: "agents.chat.effortLabel" },
		{
			id: "launch-permissions",
			tier: "pro",
			labelKey: "agents.chat.permissionLabel",
		},
	];

const CONTROLS_BY_ID = new Map(
	AGENT_TOOLBAR_CONTROLS.map((control) => [control.id, control]),
);

export interface AgentToolbarVisibilityPrefsV1 {
	/** Effective build-constrained mode, resolved before toolbar projection. */
	readonly interfaceMode: InterfaceMode;
	readonly hiddenToolbarControls?: readonly string[];
}

export interface AgentToolbarControlSignals {
	mustShow?: boolean;
}

export function agentToolbarControlVisible(
	id: AgentToolbarControlId,
	prefs: AgentToolbarVisibilityPrefsV1,
	signals: AgentToolbarControlSignals = {},
): boolean {
	if (id === "launch-permissions" && prefs.interfaceMode === "basic")
		return false;
	if (signals.mustShow === true) return true;
	if (prefs.hiddenToolbarControls?.includes(id)) return false;
	if (prefs.interfaceMode === "pro") return true;
	return CONTROLS_BY_ID.get(id)?.tier === "basic";
}

/** Descriptors for the explicitly hidden controls, in catalog order — the
 * settings restore list. Unknown persisted ids are inert and not listed. */
export function hiddenAgentToolbarControlDescriptors(
	prefs: Pick<AgentToolbarVisibilityPrefsV1, "hiddenToolbarControls">,
): readonly AgentToolbarControlDescriptorV1[] {
	const hidden = prefs.hiddenToolbarControls;
	if (!hidden || hidden.length === 0) return [];
	return AGENT_TOOLBAR_CONTROLS.filter((control) =>
		hidden.includes(control.id),
	);
}

/** The hidden list with one control restored (entry deleted, order kept). */
export function withAgentToolbarControlRestored(
	hidden: readonly string[] | undefined,
	id: AgentToolbarControlId,
): string[] {
	return (hidden ?? []).filter((entry) => entry !== id);
}

/** The hidden list with one control hidden (idempotent). */
export function withAgentToolbarControlHidden(
	hidden: readonly string[] | undefined,
	id: AgentToolbarControlId,
): string[] {
	const current = hidden ?? [];
	return current.includes(id) ? [...current] : [...current, id];
}
