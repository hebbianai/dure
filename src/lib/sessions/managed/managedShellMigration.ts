import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import {
	type HmuxManagedPaneBindingV1,
	type HmuxStandalonePaneBindingV1,
	hmuxManagedBinding,
	isTerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import {
	asRecord as record,
	nonEmptyString as nonEmpty,
} from "@/lib/payloadGuards";
import type { HmuxManagedStopFenceV1 } from "@/types";

interface ManagedShellMigrationMarkerV1 {
	schemaVersion: 1;
	operationId: string;
	source: HmuxStandalonePaneBindingV1;
	sourceTerminalEpoch: string;
	target: HmuxManagedPaneBindingV1;
	targetTerminalEpoch: string;
}

export interface ManagedShellMigrationPayloadV1
	extends ManagedShellMigrationMarkerV1 {
	desktopId: string;
	panelId: string;
	cwd: string;
}

export type ManagedShellMigrationProjection =
	| "source"
	| "target"
	| "missing"
	| "conflict";

function standaloneBinding(
	value: unknown,
): HmuxStandalonePaneBindingV1 | undefined {
	return isTerminalPaneBindingV1(value) &&
		value.runtime === "hmux_standalone_v1" &&
		value.source === "local"
		? value
		: undefined;
}

function managedBinding(value: unknown): HmuxManagedPaneBindingV1 | undefined {
	return isTerminalPaneBindingV1(value) &&
		value.runtime === "hmux_managed_v1" &&
		value.source === "local"
		? value
		: undefined;
}

function sameRuntimeIdentity(
	left: { sessionId: string; workspaceId: string },
	right: { sessionId: string; workspaceId: string },
): boolean {
	return (
		left.sessionId === right.sessionId && left.workspaceId === right.workspaceId
	);
}

function sameManagedTarget(
	left: HmuxManagedPaneBindingV1,
	right: HmuxManagedPaneBindingV1,
): boolean {
	return (
		sameRuntimeIdentity(left, right) &&
		left.createIdempotencyKey === right.createIdempotencyKey &&
		left.credentialId === right.credentialId &&
		left.credentialGeneration === right.credentialGeneration &&
		sameHmuxManagedGeneration(left.stopFence, right.stopFence)
	);
}

function managedShellMigrationMarker(
	value: unknown,
): ManagedShellMigrationMarkerV1 | undefined {
	const marker = record(value);
	const source = standaloneBinding(marker?.source);
	const target = managedBinding(marker?.target);
	if (
		marker?.schemaVersion !== 1 ||
		!nonEmpty(marker.operationId) ||
		!nonEmpty(marker.sourceTerminalEpoch) ||
		!nonEmpty(marker.targetTerminalEpoch) ||
		!source ||
		!target ||
		!target.createIdempotencyKey
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		operationId: marker.operationId,
		source,
		sourceTerminalEpoch: marker.sourceTerminalEpoch,
		target,
		targetTerminalEpoch: marker.targetTerminalEpoch,
	};
}

export function managedShellMigrationTargetBinding(input: {
	sessionId: string;
	workspaceId: string;
	idempotencyKey: string;
	stopFence: HmuxManagedStopFenceV1;
}): HmuxManagedPaneBindingV1 {
	return {
		...hmuxManagedBinding(
			input.sessionId,
			input.workspaceId,
			undefined,
			undefined,
			input.stopFence,
		),
		createIdempotencyKey: input.idempotencyKey,
	};
}

function markerMatches(
	marker: ManagedShellMigrationMarkerV1 | undefined,
	payload: ManagedShellMigrationPayloadV1,
): boolean {
	return Boolean(
		marker &&
			marker.operationId === payload.operationId &&
			marker.sourceTerminalEpoch === payload.sourceTerminalEpoch &&
			marker.targetTerminalEpoch === payload.targetTerminalEpoch &&
			sameRuntimeIdentity(marker.source, payload.source) &&
			sameManagedTarget(marker.target, payload.target),
	);
}

export function projectManagedShellMigrationLayout(
	layout: unknown,
	payload: ManagedShellMigrationPayloadV1,
): { state: ManagedShellMigrationProjection; layout: unknown } {
	let next: Record<string, unknown>;
	try {
		next = JSON.parse(JSON.stringify(layout)) as Record<string, unknown>;
	} catch {
		return { state: "conflict", layout };
	}
	const panels = record(next.panels);
	const panel = record(panels?.[payload.panelId]);
	if (!panel) return { state: "missing", layout: next };
	const params = record(panel.params) ?? {};
	const current = isTerminalPaneBindingV1(params.binding)
		? params.binding
		: undefined;
	if (
		current?.runtime === "hmux_standalone_v1" &&
		current.source === "local" &&
		sameRuntimeIdentity(current, payload.source) &&
		params.sessionId === payload.source.sessionId &&
		params.managedShellMigration === undefined
	) {
		panel.params = {
			...params,
			sessionId: payload.target.sessionId,
			cwd: payload.cwd,
			binding: payload.target,
			managedShellMigration: {
				schemaVersion: 1,
				operationId: payload.operationId,
				source: payload.source,
				sourceTerminalEpoch: payload.sourceTerminalEpoch,
				target: payload.target,
				targetTerminalEpoch: payload.targetTerminalEpoch,
			} satisfies ManagedShellMigrationMarkerV1,
		};
		return { state: "source", layout: next };
	}
	if (
		current?.runtime === "hmux_managed_v1" &&
		current.source === "local" &&
		sameManagedTarget(current, payload.target) &&
		params.sessionId === payload.target.sessionId &&
		markerMatches(
			managedShellMigrationMarker(params.managedShellMigration),
			payload,
		)
	) {
		return { state: "target", layout: next };
	}
	return { state: "conflict", layout: next };
}

export function clearManagedShellMigrationLayout(
	layout: unknown,
	payload: ManagedShellMigrationPayloadV1,
): { cleared: boolean; layout: unknown } {
	const projected = projectManagedShellMigrationLayout(layout, payload);
	if (projected.state !== "target") {
		return { cleared: false, layout: projected.layout };
	}
	const next = projected.layout as Record<string, unknown>;
	const panel = record(record(next.panels)?.[payload.panelId]);
	const params = record(panel?.params);
	if (!panel || !params) return { cleared: false, layout: next };
	const { managedShellMigration: _marker, ...withoutMarker } = params;
	panel.params = withoutMarker;
	return { cleared: true, layout: next };
}

export function managedShellMigrationPayloadFromPanel(
	desktopId: string,
	panelId: string,
	params: Record<string, unknown>,
): ManagedShellMigrationPayloadV1 | undefined {
	const marker = managedShellMigrationMarker(params.managedShellMigration);
	if (!marker || params.sessionId !== marker.target.sessionId) return undefined;
	const binding = managedBinding(params.binding);
	const cwd = typeof params.cwd === "string" ? params.cwd : "";
	if (!binding || !sameRuntimeIdentity(binding, marker.target) || !cwd) {
		return undefined;
	}
	return { ...marker, desktopId, panelId, cwd };
}
