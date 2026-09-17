import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
	compareCanonicalDecimalStrings,
	isCanonicalDecimalString,
} from "@/lib/decimalString";
import {
	durePluginPermissionGet,
	onDurePluginPermissionEvent,
} from "@/lib/ipc";
import type { DurePluginPermissionSnapshot } from "@/lib/ipc/plugins";
import { KeyedExternalStoreRegistry } from "@/lib/plugins/keyedExternalStoreRegistry";

export interface PluginPermissionWorkspaceInput {
	pluginId: string;
	workspaceRoot: string;
}

export interface PluginPermissionWorkspaceSnapshot {
	permission: DurePluginPermissionSnapshot | null;
	permissionLoaded: boolean;
	permissionError: string | null;
}

interface PermissionResource {
	input: PluginPermissionWorkspaceInput;
	snapshot: PluginPermissionWorkspaceSnapshot;
	listeners: Set<() => void>;
	active: boolean;
	loadRevision: number;
	expectedWorkspaceIdentity: string | null;
}

const EMPTY_SNAPSHOT: PluginPermissionWorkspaceSnapshot = {
	permission: null,
	permissionLoaded: false,
	permissionError: null,
};
const resources = new KeyedExternalStoreRegistry<
	PluginPermissionWorkspaceSnapshot,
	PermissionResource
>(EMPTY_SNAPSHOT);
const permissionEvents = new Map<string, DurePluginPermissionSnapshot>();
const permissionConflicts = new Set<string>();
const MAX_PERMISSION_EVENT_TARGETS = 1_024;
let permissionEventListener: Promise<string | null> | null = null;
let permissionEventUnlisten: (() => void) | null = null;
let permissionEventError: string | null = null;
let permissionEventGeneration = 0;
const PERMISSION_EVENT_SUBSCRIPTION_ERROR =
	"plugin_permission_event_subscription_failed:";

function resourceKey(input: PluginPermissionWorkspaceInput): string {
	return JSON.stringify([input.pluginId, input.workspaceRoot]);
}

function permissionTargetKey(snapshot: DurePluginPermissionSnapshot): string {
	return JSON.stringify([
		snapshot.plan.identity.plugin_id,
		snapshot.plan.workspace_identity,
	]);
}

function matchesResource(
	resource: PermissionResource,
	snapshot: DurePluginPermissionSnapshot,
): boolean {
	return (
		snapshot.plan.identity.plugin_id === resource.input.pluginId &&
		resource.expectedWorkspaceIdentity === snapshot.plan.workspace_identity
	);
}

function compareDecimalRevisions(left: string, right: string): number | null {
	return isCanonicalDecimalString(left) && isCanonicalDecimalString(right)
		? compareCanonicalDecimalStrings(left, right)
		: null;
}

type PermissionReconciliation =
	| { kind: "current"; snapshot: DurePluginPermissionSnapshot }
	| { kind: "conflict" };

function permissionSnapshotsEqual(
	left: DurePluginPermissionSnapshot,
	right: DurePluginPermissionSnapshot,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function reconcilePermissionSnapshot(
	snapshot: DurePluginPermissionSnapshot,
): PermissionReconciliation {
	const key = permissionTargetKey(snapshot);
	const current = permissionEvents.get(key);
	if (permissionConflicts.has(key)) {
		const order = current
			? compareDecimalRevisions(
					snapshot.record_revision,
					current.record_revision,
				)
			: null;
		if (order !== 1) return { kind: "conflict" };
		permissionConflicts.delete(key);
	}
	if (current) {
		const order = compareDecimalRevisions(
			snapshot.record_revision,
			current.record_revision,
		);
		if (order === null) return { kind: "conflict" };
		if (order < 0) return { kind: "current", snapshot: current };
		if (order === 0) {
			return permissionSnapshotsEqual(snapshot, current)
				? { kind: "current", snapshot: current }
				: { kind: "conflict" };
		}
	}
	permissionEvents.delete(key);
	permissionEvents.set(key, snapshot);
	if (permissionEvents.size > MAX_PERMISSION_EVENT_TARGETS) {
		const oldest = permissionEvents.keys().next().value;
		if (typeof oldest === "string") permissionEvents.delete(oldest);
	}
	return { kind: "current", snapshot };
}

function reconcileAuthoritativeLoad(
	snapshot: DurePluginPermissionSnapshot,
): PermissionReconciliation {
	const key = permissionTargetKey(snapshot);
	if (!permissionConflicts.delete(key)) {
		return reconcilePermissionSnapshot(snapshot);
	}
	permissionEvents.delete(key);
	permissionEvents.set(key, snapshot);
	return { kind: "current", snapshot };
}

function acceptPermissionSnapshot(snapshot: DurePluginPermissionSnapshot) {
	const reconciliation = reconcilePermissionSnapshot(snapshot);
	if (reconciliation.kind === "conflict") {
		permissionConflicts.add(permissionTargetKey(snapshot));
		for (const resource of resources.values()) {
			if (!matchesResource(resource, snapshot)) continue;
			resource.loadRevision += 1;
			resources.publish(resource, {
				permission: null,
				permissionLoaded: true,
				permissionError: "plugin_permission_snapshot_conflict",
			});
			void loadResource(resource);
		}
		return;
	}
	for (const resource of resources.values()) {
		if (!matchesResource(resource, reconciliation.snapshot)) continue;
		resource.expectedWorkspaceIdentity =
			reconciliation.snapshot.plan.workspace_identity;
		resource.loadRevision += 1;
		resources.publish(resource, {
			permission: reconciliation.snapshot,
			permissionLoaded: true,
			permissionError: null,
		});
	}
}

async function loadResource(resource: PermissionResource) {
	const revision = resource.loadRevision;
	try {
		const loaded = await durePluginPermissionGet({
			plugin_id: resource.input.pluginId,
			workspace_root: resource.input.workspaceRoot,
		});
		if (!resource.active || resource.loadRevision !== revision) return;
		if (loaded.plan.identity.plugin_id !== resource.input.pluginId) {
			resources.publish(resource, {
				permission: null,
				permissionLoaded: true,
				permissionError: "plugin_permission_snapshot_target_mismatch",
			});
			return;
		}
		const reconciliation = reconcileAuthoritativeLoad(loaded);
		if (reconciliation.kind === "conflict") {
			permissionConflicts.add(permissionTargetKey(loaded));
			resources.publish(resource, {
				permission: null,
				permissionLoaded: true,
				permissionError: "plugin_permission_snapshot_conflict",
			});
			return;
		}
		resource.expectedWorkspaceIdentity =
			reconciliation.snapshot.plan.workspace_identity;
		resources.publish(resource, {
			permission: reconciliation.snapshot,
			permissionLoaded: true,
			permissionError: null,
		});
	} catch (error) {
		if (!resource.active || resource.loadRevision !== revision) return;
		resources.publish(resource, {
			permission: null,
			permissionLoaded: true,
			permissionError: String(error),
		});
	}
}

function ensurePermissionEventListener(): Promise<string | null> {
	if (permissionEventListener) return permissionEventListener;
	const generation = permissionEventGeneration;
	permissionEventListener = onDurePluginPermissionEvent((snapshot) => {
		acceptPermissionSnapshot(snapshot);
	})
		.then((unlisten) => {
			if (permissionEventGeneration !== generation) {
				unlisten();
				return "plugin_permission_event_subscription_superseded";
			}
			permissionEventUnlisten = unlisten;
			permissionEventError = null;
			for (const resource of resources.values()) {
				if (
					!resource.active ||
					!resource.snapshot.permissionError?.startsWith(
						PERMISSION_EVENT_SUBSCRIPTION_ERROR,
					)
				) {
					continue;
				}
				resource.loadRevision += 1;
				void loadResource(resource);
			}
			return null;
		})
		.catch((error) => {
			const message = `${PERMISSION_EVENT_SUBSCRIPTION_ERROR} ${String(error)}`;
			if (permissionEventGeneration === generation) {
				permissionEventUnlisten = null;
				permissionEventError = message;
			}
			return message;
		});
	return permissionEventListener;
}

async function startResource(resource: PermissionResource) {
	const revision = resource.loadRevision;
	const observationError = await ensurePermissionEventListener();
	if (!resource.active || resource.loadRevision !== revision) return;
	if (observationError) {
		resources.publish(resource, {
			permission: null,
			permissionLoaded: true,
			permissionError: observationError,
		});
		return;
	}
	await loadResource(resource);
}

function createResource(input: PluginPermissionWorkspaceInput) {
	return {
		input,
		snapshot: EMPTY_SNAPSHOT,
		loadRevision: 0,
		expectedWorkspaceIdentity: null,
	};
}

export function usePluginPermissionWorkspace(
	input: PluginPermissionWorkspaceInput | null,
): PluginPermissionWorkspaceSnapshot {
	const stableInput = useMemo(
		() =>
			input
				? {
						pluginId: input.pluginId,
						workspaceRoot: input.workspaceRoot,
					}
				: null,
		[input?.pluginId, input?.workspaceRoot],
	);
	const key = useMemo(
		() => (stableInput ? resourceKey(stableInput) : null),
		[stableInput],
	);
	const subscribe = useCallback(
		(listener: () => void) =>
			resources.subscribe(
				key,
				stableInput,
				listener,
				createResource,
				startResource,
			),
		[key, stableInput],
	);
	const getSnapshot = useCallback(() => resources.snapshot(key), [key]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function publishPluginPermissionSnapshot(
	snapshot: DurePluginPermissionSnapshot,
) {
	if (permissionEventError) {
		for (const resource of resources.values()) {
			if (snapshot.plan.identity.plugin_id !== resource.input.pluginId) continue;
			resources.publish(resource, {
				permission: null,
				permissionLoaded: true,
				permissionError: permissionEventError,
			});
		}
		return;
	}
	acceptPermissionSnapshot(snapshot);
}

export function refreshPluginPermissionWorkspace(
	input: PluginPermissionWorkspaceInput,
) {
	const resource = resources.get(resourceKey(input));
	if (!resource) return;
	if (permissionEventError) {
		permissionEventGeneration += 1;
		permissionEventListener = null;
		permissionEventUnlisten = null;
		permissionEventError = null;
	}
	resource.loadRevision += 1;
	void startResource(resource);
}

export function resetPluginPermissionWorkspaceResourcesForTests() {
	resources.reset();
	permissionEvents.clear();
	permissionConflicts.clear();
	permissionEventGeneration += 1;
	permissionEventUnlisten?.();
	permissionEventUnlisten = null;
	permissionEventListener = null;
	permissionEventError = null;
}
