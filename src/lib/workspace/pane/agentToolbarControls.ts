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
 *
 * One toolbar renders on two surfaces: the Agent's pane and its large window
 * (#624). Each descriptor's `largeWindow` rule is the only place a control
 * differs between them, and no attention signal overrides it. The large
 * window has no Dockview pane of its own, so an offered control either runs
 * in the source pane's window through the agent-session bridge or needs no
 * pane at all.
 */

import type { InterfaceMode } from "@/lib/workspace/pane/interfaceMode";

export type AgentToolbarControlId =
	| "account"
	| "launch-model"
	| "launch-effort"
	| "launch-permissions"
	| "view-switch"
	| "project-move"
	| "diff-window"
	| "source-control-window"
	| "conversation-history";

export type AgentToolbarSurface = "pane" | "large_window";

/** How the large window offers a control, or why it does not. */
type AgentToolbarLargeWindowRule =
	| {
			readonly offered: true;
			/** `source_pane`: runs in the source pane's window over the bridge.
			 * `local`: needs no pane; it runs wherever the toolbar is. */
			readonly runs: "source_pane" | "local";
	  }
	| { readonly offered: false; readonly reason: string };

export interface AgentToolbarControlDescriptorV1 {
	readonly id: AgentToolbarControlId;
	/** Lowest interface mode that shows the control by default. */
	readonly tier: InterfaceMode;
	/** i18n key for a short neutral control name (hide menu, restore list). */
	readonly labelKey: string;
	readonly largeWindow: AgentToolbarLargeWindowRule;
}

// Not yet routed through the bridge; each is a follow-up slice of #624, and
// the control runs only where the source pane's own runtime state lives.
const LAUNCH_SELECTION_NOT_ROUTED: AgentToolbarLargeWindowRule = {
	offered: false,
	reason:
		"The committed launch selection is runtime state of the source window and its changes have no bridge command yet.",
};

export const AGENT_TOOLBAR_CONTROLS: readonly AgentToolbarControlDescriptorV1[] =
	[
		// #554 (M3 handover) reverses the 2026-08-31 Pro-only call: the one
		// View control (Terminal / Conversation / Chat) is how a Basic user
		// moves an existing terminal agent into Chat.
		{
			id: "view-switch",
			tier: "basic",
			labelKey: "agents.runtime.viewLabel",
			largeWindow: { offered: true, runs: "source_pane" },
		},
		{
			id: "project-move",
			tier: "pro",
			labelKey: "agents.projectMove.title",
			largeWindow: { offered: true, runs: "source_pane" },
		},
		{
			id: "diff-window",
			tier: "basic",
			labelKey: "panels.agent.toolbar.control.diffWindow",
			// Opens the Agent's own diff window; no pane is involved.
			largeWindow: { offered: true, runs: "local" },
		},
		{
			id: "source-control-window",
			tier: "basic",
			labelKey: "panels.agent.toolbar.control.sourceControlWindow",
			largeWindow: { offered: true, runs: "local" },
		},
		{
			id: "conversation-history",
			tier: "basic",
			labelKey: "panels.agent.toolbar.control.conversationHistory",
			largeWindow: {
				offered: false,
				reason:
					"Opening or replacing a conversation places panes in the source window's Dockview and has no bridge command yet.",
			},
		},
		{
			id: "account",
			tier: "basic",
			labelKey: "common.paneAccount",
			largeWindow: { offered: true, runs: "source_pane" },
		},
		{
			id: "launch-model",
			tier: "pro",
			labelKey: "agents.chat.modelLabel",
			largeWindow: LAUNCH_SELECTION_NOT_ROUTED,
		},
		{
			id: "launch-effort",
			tier: "pro",
			labelKey: "agents.chat.effortLabel",
			largeWindow: LAUNCH_SELECTION_NOT_ROUTED,
		},
		{
			id: "launch-permissions",
			tier: "pro",
			labelKey: "agents.chat.permissionLabel",
			largeWindow: LAUNCH_SELECTION_NOT_ROUTED,
		},
	];

const CONTROLS_BY_ID = new Map(
	AGENT_TOOLBAR_CONTROLS.map((control) => [control.id, control]),
);

export interface AgentToolbarVisibilityPrefsV1 {
	/** Effective build-constrained mode, resolved before toolbar projection. */
	readonly interfaceMode: InterfaceMode;
	readonly hiddenToolbarControls?: readonly string[];
	/** The surface rendering the toolbar; a pane when omitted. */
	readonly surface?: AgentToolbarSurface;
}

/** Whether a surface offers a control at all, before mode and hide prefs. */
export function agentToolbarControlOffered(
	id: AgentToolbarControlId,
	surface: AgentToolbarSurface,
): boolean {
	return (
		surface === "pane" || CONTROLS_BY_ID.get(id)?.largeWindow.offered === true
	);
}

export interface AgentToolbarControlSignals {
	mustShow?: boolean;
}

export function agentToolbarControlVisible(
	id: AgentToolbarControlId,
	prefs: AgentToolbarVisibilityPrefsV1,
	signals: AgentToolbarControlSignals = {},
): boolean {
	if (!agentToolbarControlOffered(id, prefs.surface ?? "pane")) return false;
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
