import { isRecord } from "@/lib/payloadGuards";
import type { MovePanelsToDesktopReceipt } from "@/lib/workspace/desktop/desktopPaneMove";
import { isSerializedDockviewLayout } from "@/lib/workspace/layout/layoutLifecycle";
import {
	type MountedPaneWindow,
	parseMountedPaneWindow,
} from "@/lib/workspace/window/mountedPaneWindow";
import {
	type MountedWorkspaceWindow,
	mountedWindowIdentifier,
	parseMountedWorkspaceWindow,
} from "@/lib/workspace/window/mountedWindowIdentity";
import {
	type PreparedAgentChatDraftTarget,
	parseAgentChatDraftTarget,
} from "./agentChatDraftInput";
import type {
	AgentChatDraftTransfer,
	AgentChatPaneDropPosition,
} from "./agentChatDraftTypes";

export type { AgentChatPaneDropPosition } from "./agentChatDraftTypes";

import { parseAgentChatDraftMoveRequest } from "./agentChatDraftMoveRequest";

export interface AgentChatPaneMoveRequest {
	readonly target: PreparedAgentChatDraftTarget;
	readonly source: MountedPaneWindow;
	readonly destination: MountedWorkspaceWindow;
	readonly position: AgentChatPaneDropPosition;
}
export interface AgentChatPaneDropRequest {
	readonly transfer: AgentChatDraftTransfer;
	readonly position: AgentChatPaneDropPosition;
}
export interface AgentChatPaneMoveResult {
	readonly kind: "pane_moved";
	readonly id: string;
	readonly receipt: MovePanelsToDesktopReceipt;
}

/** Only IDs and finite geometry cross windows, never native Dockview objects. */
export function parseChatPaneDropPosition(
	value: unknown,
): AgentChatPaneDropPosition | undefined {
	if (!isRecord(value)) return undefined;
	if (value.floating !== undefined) {
		const f = value.floating;
		if (
			!isRecord(f) ||
			typeof f.x !== "number" ||
			!Number.isFinite(f.x) ||
			typeof f.y !== "number" ||
			!Number.isFinite(f.y) ||
			[f.width, f.height].some(
				(n) =>
					n !== undefined &&
					(typeof n !== "number" || !Number.isFinite(n) || n <= 0),
			)
		)
			return undefined;
		return {
			floating: {
				x: f.x,
				y: f.y,
				...(f.width === undefined ? {} : { width: f.width as number }),
				...(f.height === undefined ? {} : { height: f.height as number }),
			},
		};
	}
	if (
		value.direction !== "left" &&
		value.direction !== "right" &&
		value.direction !== "above" &&
		value.direction !== "below"
	)
		return undefined;
	const group = isRecord(value.referenceGroup)
		? value.referenceGroup.id
		: value.referenceGroup;
	if (group !== undefined && !mountedWindowIdentifier(group)) return undefined;
	if (
		value.referencePanel !== undefined &&
		!mountedWindowIdentifier(value.referencePanel)
	)
		return undefined;
	return {
		direction: value.direction,
		...(group === undefined ? {} : { referenceGroup: group }),
		...(value.referencePanel === undefined
			? {}
			: { referencePanel: value.referencePanel }),
	};
}
export function parseAgentChatPaneMoveRequest(
	value: unknown,
): AgentChatPaneMoveRequest | undefined {
	if (!isRecord(value)) return undefined;
	const target = parseAgentChatDraftTarget(value.target);
	const source = parseMountedPaneWindow(value.source);
	const destination = parseMountedWorkspaceWindow(value.destination);
	const position = parseChatPaneDropPosition(value.position);
	if (
		!target ||
		!source ||
		!destination ||
		!position ||
		source.desktopId === destination.desktopId ||
		source.windowLabel === destination.windowLabel
	)
		return undefined;
	return { target, source, destination, position };
}
export function parseAgentChatPaneDropRequest(
	value: unknown,
): AgentChatPaneDropRequest | undefined {
	if (!isRecord(value)) return undefined;
	const draft = parseAgentChatDraftMoveRequest({
		step: "status",
		transfer: value.transfer,
	});
	const position = parseChatPaneDropPosition(value.position);
	return draft && position ? { transfer: draft.transfer, position } : undefined;
}
export function isChatPaneMoveResult(
	value: unknown,
	paneId: string,
): value is AgentChatPaneMoveResult {
	if (
		!isRecord(value) ||
		value.kind !== "pane_moved" ||
		!mountedWindowIdentifier(value.id) ||
		!isRecord(value.receipt)
	)
		return false;
	const r = value.receipt;
	return (
		r.error === undefined &&
		Array.isArray(r.movedPanelIds) &&
		r.movedPanelIds.length === 1 &&
		r.movedPanelIds[0] === paneId &&
		[
			r.touchedDesktopIds,
			r.projectedDesktopIds,
			r.projectionFailedDesktopIds,
		].every(
			(list) => Array.isArray(list) && list.every(mountedWindowIdentifier),
		) &&
		isRecord(r.updates) &&
		Object.values(r.updates).every(isSerializedDockviewLayout)
	);
}
