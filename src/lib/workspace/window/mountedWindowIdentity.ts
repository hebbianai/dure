import { isRecord } from "@/lib/payloadGuards";

export const MOUNTED_WINDOW_REQUEST_EVENT = "dure://pane-owner/request";
export const MOUNTED_WINDOW_RESPONSE_EVENT = "dure://pane-owner/response";
export const mountedWindowGeneration = crypto.randomUUID();

export interface MountedWorkspaceWindow {
	readonly schemaVersion: 1;
	readonly desktopId: string;
	readonly dockviewId: string;
	readonly windowLabel: string;
	readonly windowGeneration: string;
}

export function mountedWindowIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export function parseMountedWorkspaceWindow(
	value: unknown,
): MountedWorkspaceWindow | undefined {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		!mountedWindowIdentifier(value.desktopId) ||
		!mountedWindowIdentifier(value.dockviewId) ||
		!mountedWindowIdentifier(value.windowLabel) ||
		!mountedWindowIdentifier(value.windowGeneration)
	)
		return undefined;
	return {
		schemaVersion: 1,
		desktopId: value.desktopId,
		dockviewId: value.dockviewId,
		windowLabel: value.windowLabel,
		windowGeneration: value.windowGeneration,
	};
}

export interface MountedPaneWindow extends MountedWorkspaceWindow {
	readonly paneId: string;
}
