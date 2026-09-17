import { LEGACY_PRODUCT_COMPATIBILITY } from "@/lib/platform/legacyProductCompatibility";

export const PANE_TRANSFER_MIME = "application/x-dure-pane";
export const PANE_TRANSFER_INPUT_MIMES = [
	PANE_TRANSFER_MIME,
	LEGACY_PRODUCT_COMPATIBILITY.paneTransferMime,
] as const;
export const PANE_WINDOW_DROP_EVENT = "dure:pane-window-drop-v1";
export const PANE_WINDOW_DROP_INPUT_EVENTS = [
	PANE_WINDOW_DROP_EVENT,
	LEGACY_PRODUCT_COMPATIBILITY.paneWindowDropEvent,
] as const;

const IDENTITY_LIMIT = 512;
const ROOT_EDGE_SIZE = 24;

export interface PaneTransferPayload {
	schemaVersion: 1;
	requestId: string;
	panelId: string;
	fromDesktopId: string;
	sourceWindowLabel: string;
}

export interface PaneWindowDropRequest extends PaneTransferPayload {
	targetWindowLabel: string;
	screenX: number;
	screenY: number;
}

export interface LabeledScreenRect {
	label: string;
	x: number;
	y: number;
	width: number;
	height: number;
	workspace: boolean;
	focused?: boolean;
}

export type PaneDragReleaseTarget =
	| { kind: "workspace"; windowLabel: string }
	| { kind: "outside" }
	| { kind: "blocked" }
	| { kind: "unknown" };

export interface PaneDropRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PaneDropGroup<T> {
	value: T;
	bounds: PaneDropRect;
}

export interface ResolvedPaneDropPosition<T> {
	referenceGroup?: T;
	direction: "left" | "right" | "above" | "below";
}

export interface PaneProjectionSpec {
	id: string;
	component: string;
	title?: string;
	tabComponent?: string;
	renderer?: unknown;
	params?: Record<string, unknown>;
	minimumWidth?: number;
	minimumHeight?: number;
	maximumWidth?: number;
	maximumHeight?: number;
}

function validIdentity(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= IDENTITY_LIMIT
	);
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function cloneRecord(value: unknown): Record<string, unknown> | undefined {
	const record = recordOf(value);
	if (!record) return undefined;
	try {
		return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function paneProjectionSpecFromLayout(
	layoutValue: unknown,
	panelId: string,
): PaneProjectionSpec | null {
	const panels = recordOf(recordOf(layoutValue)?.panels);
	const definition = recordOf(panels?.[panelId]);
	if (!definition || typeof definition.contentComponent !== "string") {
		return null;
	}
	const params = cloneRecord(definition.params);
	const minimumWidth = finiteNumber(definition.minimumWidth);
	const minimumHeight = finiteNumber(definition.minimumHeight);
	const maximumWidth = finiteNumber(definition.maximumWidth);
	const maximumHeight = finiteNumber(definition.maximumHeight);
	return {
		id: panelId,
		component: definition.contentComponent,
		...(typeof definition.title === "string"
			? { title: definition.title }
			: {}),
		...(typeof definition.tabComponent === "string"
			? { tabComponent: definition.tabComponent }
			: {}),
		...(definition.renderer !== undefined
			? { renderer: definition.renderer }
			: {}),
		...(params ? { params } : {}),
		...(minimumWidth !== undefined ? { minimumWidth } : {}),
		...(minimumHeight !== undefined ? { minimumHeight } : {}),
		...(maximumWidth !== undefined ? { maximumWidth } : {}),
		...(maximumHeight !== undefined ? { maximumHeight } : {}),
	};
}

function randomRequestId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	}
}

export function createPaneTransferPayload(
	input: Omit<PaneTransferPayload, "schemaVersion" | "requestId">,
	requestId = randomRequestId(),
): PaneTransferPayload {
	return {
		schemaVersion: 1,
		requestId,
		panelId: input.panelId,
		fromDesktopId: input.fromDesktopId,
		sourceWindowLabel: input.sourceWindowLabel,
	};
}

export function serializePaneTransferPayload(
	payload: PaneTransferPayload,
): string {
	return JSON.stringify(payload);
}

export function parsePaneTransferPayload(
	raw: string,
): PaneTransferPayload | null {
	if (!raw || raw.length > 4_096) return null;
	try {
		const value = recordOf(JSON.parse(raw));
		if (
			value?.schemaVersion !== 1 ||
			!validIdentity(value.requestId) ||
			!validIdentity(value.panelId) ||
			!validIdentity(value.fromDesktopId) ||
			!validIdentity(value.sourceWindowLabel)
		) {
			return null;
		}
		return {
			schemaVersion: 1,
			requestId: value.requestId,
			panelId: value.panelId,
			fromDesktopId: value.fromDesktopId,
			sourceWindowLabel: value.sourceWindowLabel,
		};
	} catch {
		return null;
	}
}

export function createPaneWindowDropRequest(
	payload: PaneTransferPayload,
	targetWindowLabel: string,
	point: { x: number; y: number },
): PaneWindowDropRequest {
	return {
		...payload,
		targetWindowLabel,
		screenX: point.x,
		screenY: point.y,
	};
}

export function parsePaneWindowDropRequest(
	value: unknown,
): PaneWindowDropRequest | null {
	const request = recordOf(value);
	if (!request) return null;
	const payload = parsePaneTransferPayload(
		JSON.stringify({
			schemaVersion: request.schemaVersion,
			requestId: request.requestId,
			panelId: request.panelId,
			fromDesktopId: request.fromDesktopId,
			sourceWindowLabel: request.sourceWindowLabel,
		}),
	);
	if (
		!payload ||
		!validIdentity(request.targetWindowLabel) ||
		typeof request.screenX !== "number" ||
		!Number.isFinite(request.screenX) ||
		typeof request.screenY !== "number" ||
		!Number.isFinite(request.screenY)
	) {
		return null;
	}
	return {
		...payload,
		targetWindowLabel: request.targetWindowLabel,
		screenX: request.screenX,
		screenY: request.screenY,
	};
}

function contains(
	point: { x: number; y: number },
	rect: PaneDropRect,
): boolean {
	return (
		point.x >= rect.x &&
		point.x <= rect.x + rect.width &&
		point.y >= rect.y &&
		point.y <= rect.y + rect.height
	);
}

export function paneDragReleaseTarget(
	point: { x: number; y: number },
	sourceWindowLabel: string,
	windows: readonly LabeledScreenRect[],
): PaneDragReleaseTarget {
	if (windows.length === 0) return { kind: "unknown" };
	const containing = windows
		.filter((windowRect) => contains(point, windowRect))
		.sort((left, right) => Number(right.focused) - Number(left.focused));
	const focused = containing.find((windowRect) => windowRect.focused);
	if (focused) {
		if (focused.label === sourceWindowLabel) return { kind: "blocked" };
		return focused.workspace
			? { kind: "workspace", windowLabel: focused.label }
			: { kind: "blocked" };
	}
	const target = containing.find(
		(windowRect) =>
			windowRect.workspace && windowRect.label !== sourceWindowLabel,
	);
	if (target) {
		return { kind: "workspace", windowLabel: target.label };
	}
	return containing.length > 0 ? { kind: "blocked" } : { kind: "outside" };
}

function nearestDirection(
	point: { x: number; y: number },
	rect: PaneDropRect,
	maxDistance: number,
): ResolvedPaneDropPosition<never>["direction"] | null {
	const distances = [
		{ direction: "left" as const, distance: point.x - rect.x },
		{ direction: "right" as const, distance: rect.x + rect.width - point.x },
		{ direction: "above" as const, distance: point.y - rect.y },
		{ direction: "below" as const, distance: rect.y + rect.height - point.y },
	];
	distances.sort((left, right) => left.distance - right.distance);
	return distances[0].distance <= maxDistance ? distances[0].direction : null;
}

/**
 * Resolve a native cross-window release to the same edge semantics used by
 * Dockview. Pane centers deliberately return null: Dure treats one group
 * as one pane and does not create tab stacks as a side effect of a fallback
 * transfer.
 */
export function resolvePaneDropPosition<T>(
	point: { x: number; y: number },
	dockBounds: PaneDropRect,
	groups: readonly PaneDropGroup<T>[],
): ResolvedPaneDropPosition<T> | null {
	if (!contains(point, dockBounds)) return null;
	const rootDirection = nearestDirection(point, dockBounds, ROOT_EDGE_SIZE);
	if (rootDirection) return { direction: rootDirection };

	const group = groups.find((candidate) => contains(point, candidate.bounds));
	if (!group) return null;
	const activation = Math.round(
		Math.max(
			24,
			Math.min(80, Math.min(group.bounds.width, group.bounds.height) * 0.2),
		),
	);
	const direction = nearestDirection(point, group.bounds, activation);
	return direction ? { referenceGroup: group.value, direction } : null;
}
