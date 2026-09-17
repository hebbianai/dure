import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import {
	agentIdFromAgentPanelId,
	agentIdFromPaneParameters,
} from "@/lib/workspace/layout/agentPaneParameters";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";

export type AgentPaneSelection =
	| { kind: "agent"; agentId: string }
	| { kind: "pane"; agentId: string; panelId: string };

export type OptionalAgentPaneSelection =
	| AgentPaneSelection
	| { kind: "absent"; panelId: string };

/** Mounted content replaces that Space's saved projection, including removal.
 * Reading a target never mounts a Space or changes the user's selection. */
function agentIdForPane(panelId: string): string | undefined {
	const panes = [...dockviewRegistry.values()].flatMap((api) => {
		const panel = api.getPanel(panelId);
		return panel ? [dockPanelReference(panel)] : [];
	});
	for (const [spaceId, layout] of Object.entries(useStore.getState().layouts)) {
		if (dockviewRegistry.has(spaceId)) continue;
		const pane = panelsFromLayout(layout).find((pane) => pane.id === panelId);
		if (pane) panes.push(pane);
	}
	if (panes.length > 1) {
		throw new PaneCommandError(
			"pane_ambiguous",
			`pane ${panelId} is present in multiple Spaces`,
		);
	}
	const pane = panes[0];
	if (!pane) return undefined;
	const agentId =
		pane.component === "agent"
			? agentIdFromPaneParameters(pane.params)
			: undefined;
	if (!agentId) {
		throw new PaneCommandError(
			"pane_changed",
			`pane ${panelId} no longer references an Agent`,
		);
	}
	return agentId;
}

export function resolveAgentPaneSelection(panelId: string): AgentPaneSelection {
	const selection = resolveOptionalAgentPaneSelection(panelId);
	if (selection.kind === "absent") {
		throw new PaneCommandError(
			"invalid_request",
			"targetPanelId must identify an Agent pane",
		);
	}
	return selection;
}

/** Absence permits cleanup reconciliation, not a new pane-scoped command. */
export function resolveOptionalAgentPaneSelection(
	panelId: string,
): OptionalAgentPaneSelection {
	const agentId = agentIdForPane(panelId);
	if (agentId) return { kind: "pane", panelId, agentId };
	// V1 also addressed headless Agents through this historical alias. Decode it
	// only at ingress; a prepared pane must never become a headless Agent target.
	const legacyAgentId = agentIdFromAgentPanelId(panelId);
	return legacyAgentId
		? { kind: "agent", agentId: legacyAgentId }
		: { kind: "absent", panelId };
}

/** Named Agent commands address the registry directly, even without a view. */
export function resolveNamedAgentPaneSelection(
	agentId: string,
	panelId?: string,
): AgentPaneSelection {
	const selection: AgentPaneSelection = panelId
		? resolveAgentPaneSelection(panelId)
		: { kind: "agent", agentId };
	if (selection.agentId !== agentId) {
		throw new PaneCommandError(
			"pane_changed",
			"selected pane references a different Agent",
		);
	}
	return selection;
}

/** A delayed request retains its observed recipient, not the pane ID's alias. */
export function revalidateAgentPaneSelection(
	selection: OptionalAgentPaneSelection,
): void {
	if (
		selection.kind === "absent" ||
		(selection.kind === "pane" &&
			agentIdForPane(selection.panelId) !== selection.agentId)
	) {
		throw new PaneCommandError("pane_changed", "prepared Agent pane changed");
	}
}
