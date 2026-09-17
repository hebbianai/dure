import type { DockviewApi } from "dockview-react";
import { asRecord as record } from "@/lib/payloadGuards";
import {
	bindingFromPane,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import type { SerializedPanelRef } from "@/lib/workspace/layout/layoutLifecycle";

interface DockPanelLike {
	params?: unknown;
	api: {
		getParameters(): unknown;
	};
}

/**
 * DockView does not seed PanelApi.getParameters() from addPanel params.
 * The panel model is the canonical merged parameter state.
 */
export function dockPanelParameters(
	panel: DockPanelLike,
): Record<string, unknown> {
	return record(panel.params) ?? record(panel.api.getParameters()) ?? {};
}

export function dockPanelReference(
	panel: DockPanelLike & { id: string; api: { component: string } },
): SerializedPanelRef {
	return {
		id: panel.id,
		component: panel.api.component,
		params: dockPanelParameters(panel),
	};
}

export function findAgentPanel(
	api: Pick<DockviewApi, "panels">,
	agentId: string,
) {
	return api.panels.find(
		(panel) => agentIdFromPane(dockPanelReference(panel)) === agentId,
	);
}

export function findTerminalPanel(
	api: Pick<DockviewApi, "panels">,
	target: TerminalPaneBindingV1,
) {
	return api.panels.find((panel) => {
		if (panel.api.component !== "terminal") return false;
		const binding = bindingFromPane(dockPanelReference(panel), [], []);
		return (
			binding?.runtime === target.runtime &&
			binding.source === target.source &&
			binding.hostId === target.hostId &&
			binding.workspaceId === target.workspaceId &&
			binding.sessionId === target.sessionId
		);
	});
}
