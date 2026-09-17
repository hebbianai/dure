import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
	resetPluginPermissionWorkspaceResourcesForTests,
	type PluginPermissionWorkspaceSnapshot,
	usePluginPermissionWorkspace,
} from "@/components/plugins/usePluginPermissionWorkspace";
import {
	compareCanonicalDecimalStrings as compareSettingsRevisions,
	isCanonicalDecimalString,
} from "@/lib/decimalString";
import {
	dureIssueTrackerActivationGet,
	durePluginSettingsGet,
	onDureIssueTrackerActivationEvent,
	onDurePluginSettingsEvent,
} from "@/lib/ipc";
import {
	type DurePluginSettingsSnapshot,
	type DurePluginSettingsTargetV2,
	pluginSettingsTargetsEqual,
} from "@/lib/plugins/durePlugins";
import { KeyedExternalStoreRegistry } from "@/lib/plugins/keyedExternalStoreRegistry";
import type { PluginWorkspaceContext } from "@/lib/plugins/pluginWorkspace";

export interface PluginIssueTrackerWorkspaceInput {
	pluginId: string;
	contributionId: string;
	settingsTarget: DurePluginSettingsTargetV2 | null;
	workspace: PluginWorkspaceContext;
}

interface IssueTrackerWorkspaceSnapshot {
	activation: "checking" | "required" | "active";
	activationError: string | null;
	settings: DurePluginSettingsSnapshot | null;
	settingsLoaded: boolean;
	settingsError: string | null;
}

export interface PluginIssueTrackerWorkspaceSnapshot
	extends IssueTrackerWorkspaceSnapshot,
		PluginPermissionWorkspaceSnapshot {}

export interface PluginSettingsInvalidationToken {
	id: number;
	target: DurePluginSettingsTargetV2;
	scopeKey: string;
	workspaceRoot: string;
}

export interface PluginSettingsReconcileReceipt {
	candidateIsWinner: boolean;
	matchedResources: number;
	current: DurePluginSettingsSnapshot | null;
	reason: "accepted" | "superseded" | "conflict" | "revalidation_failed";
}

interface WorkspaceResource {
	input: PluginIssueTrackerWorkspaceInput;
	authoritativeWorkspaceIdentity: string | null;
	snapshot: IssueTrackerWorkspaceSnapshot;
	listeners: Set<() => void>;
	active: boolean;
	unlisten: Array<() => void>;
	activationRevision: number;
	settingsLoadRevision: number;
	expectedSettingsScopeKey: string | null;
	pendingSettings: Map<string, DurePluginSettingsSnapshot>;
	settingsObservationError: string | null;
	settingsRevisionFloor: string | null;
	settingsFingerprintAtFloor: string | null;
	settingsPolicyEpochsAtFloor: Record<string, number>;
	settingsInvalidatedAtRevision: string | null;
	settingsInvalidationId: number | null;
	activationEventListening: boolean;
	settingsEventListening: boolean;
	eventRetryAttempt: number;
	eventRetryTimer: ReturnType<typeof setTimeout> | null;
}

const EMPTY_SNAPSHOT: IssueTrackerWorkspaceSnapshot = {
	activation: "checking",
	activationError: null,
	settings: null,
	settingsLoaded: false,
	settingsError: null,
};
const EVENT_RETRY_DELAYS_MS = [250, 1_000, 5_000] as const;
const resources = new KeyedExternalStoreRegistry<
	IssueTrackerWorkspaceSnapshot,
	WorkspaceResource
>(EMPTY_SNAPSHOT);
const settingsRevalidationRetries = new Map<
	number,
	{
		attempt: number;
		timer: ReturnType<typeof setTimeout> | null;
		token: PluginSettingsInvalidationToken;
	}
>();
let nextSettingsInvalidationId = 1;

function resourceKey(
	input: PluginIssueTrackerWorkspaceInput,
	authoritativeWorkspaceIdentity: string,
): string {
	return JSON.stringify([
		input.pluginId,
		input.contributionId,
		input.settingsTarget,
		input.workspace.root,
		input.workspace.scopeKey,
		authoritativeWorkspaceIdentity,
	]);
}

function matchesSettingsTarget(
	resource: WorkspaceResource,
	snapshot: DurePluginSettingsSnapshot,
): snapshot is DurePluginSettingsSnapshot & { scope_key: string } {
	const { input } = resource;
	return (
		input.settingsTarget !== null &&
		pluginSettingsTargetsEqual(snapshot.target, input.settingsTarget) &&
		snapshot.scope === "workspace" &&
		typeof snapshot.scope_key === "string" &&
		snapshot.scope_key.length > 0
	);
}

function settingsRevision(snapshot: DurePluginSettingsSnapshot): string | null {
	const revision = snapshot.settings_revision ?? "0";
	return isCanonicalDecimalString(revision) ? revision : null;
}

function maxSettingsRevision(
	...revisions: Array<string | null>
): string | null {
	let maximum: string | null = null;
	for (const revision of revisions) {
		if (
			revision !== null &&
			(maximum === null || compareSettingsRevisions(revision, maximum) > 0)
		) {
			maximum = revision;
		}
	}
	return maximum;
}

function mergeSettingsPolicyEpochs(
	current: Record<string, number>,
	candidate: Record<string, number> | undefined,
): Record<string, number> {
	const merged = { ...current };
	for (const [key, epoch] of Object.entries(candidate ?? {})) {
		merged[key] = Math.max(merged[key] ?? 0, epoch);
	}
	return merged;
}

function settingsFingerprint(snapshot: DurePluginSettingsSnapshot): string {
	return JSON.stringify([
		snapshot.target,
		snapshot.scope,
		snapshot.scope_key,
		snapshot.values,
	]);
}

function settingsPolicyEpochsAreCurrent(
	candidate: Record<string, number> | undefined,
	current: Record<string, number>,
): boolean {
	for (const [key, epoch] of Object.entries(current)) {
		if ((candidate?.[key] ?? -1) < epoch) return false;
	}
	return true;
}

function publishSettingsConflict(resource: WorkspaceResource) {
	resources.publish(resource, {
		...resource.snapshot,
		settings: null,
		settingsLoaded: true,
		settingsError: "plugin_settings_snapshot_conflict",
	});
}

function acceptSettingsSnapshot(
	resource: WorkspaceResource,
	snapshot: DurePluginSettingsSnapshot,
	options: { authoritative?: boolean; invalidationId?: number } = {},
): boolean {
	const authoritative = options.authoritative ?? false;
	if (
		!matchesSettingsTarget(resource, snapshot) ||
		resource.expectedSettingsScopeKey !== snapshot.scope_key
	) {
		return false;
	}
	const candidateRevision = settingsRevision(snapshot);
	if (candidateRevision === null) {
		publishSettingsConflict(resource);
		return false;
	}
	const candidateFingerprint = settingsFingerprint(snapshot);
	const invalidatedAtRevision = resource.settingsInvalidatedAtRevision;
	if (invalidatedAtRevision !== null) {
		const invalidationOrder = compareSettingsRevisions(
			candidateRevision,
			invalidatedAtRevision,
		);
		if (invalidationOrder < 0) return false;
		if (
			invalidationOrder === 0 &&
			(!authoritative ||
				options.invalidationId !== resource.settingsInvalidationId)
		) {
			return false;
		}
	}
	const currentRevision = resource.settingsRevisionFloor;
	if (currentRevision !== null) {
		const order = compareSettingsRevisions(candidateRevision, currentRevision);
		if (order < 0) return false;
		if (
			order === 0 &&
			resource.settingsFingerprintAtFloor !== candidateFingerprint
		) {
			publishSettingsConflict(resource);
			return false;
		}
		if (
			order === 0 &&
			!settingsPolicyEpochsAreCurrent(
				snapshot.agent_claim_policy_epochs,
				resource.settingsPolicyEpochsAtFloor,
			)
		) {
			return false;
		}
	}
	resource.settingsRevisionFloor = candidateRevision;
	resource.settingsFingerprintAtFloor = candidateFingerprint;
	resource.settingsPolicyEpochsAtFloor = {
		...(snapshot.agent_claim_policy_epochs ?? {}),
	};
	resource.settingsInvalidatedAtRevision = null;
	const settledInvalidationId = resource.settingsInvalidationId;
	resource.settingsInvalidationId = null;
	if (settledInvalidationId !== null) {
		clearSettingsRevalidationRetry(settledInvalidationId);
	}
	resources.publish(resource, {
		...resource.snapshot,
		settings: snapshot,
		settingsLoaded: true,
		settingsError: resource.settingsObservationError,
	});
	return true;
}

function queueOrAcceptSettingsSnapshot(
	resource: WorkspaceResource,
	snapshot: DurePluginSettingsSnapshot,
	options: { authoritative?: boolean; invalidationId?: number } = {},
): boolean {
	if (!matchesSettingsTarget(resource, snapshot)) return false;
	const scopeKey = snapshot.scope_key;
	if (resource.expectedSettingsScopeKey === null) {
		const current = resource.pendingSettings.get(scopeKey);
		const candidateRevision = settingsRevision(snapshot);
		if (candidateRevision === null) return false;
		const currentRevision = current ? settingsRevision(current) : null;
		if (
			!current ||
			(currentRevision !== null &&
				compareSettingsRevisions(candidateRevision, currentRevision) >= 0)
		) {
			resource.pendingSettings.set(scopeKey, snapshot);
		}
		if (resource.pendingSettings.size > 16) {
			const oldest = resource.pendingSettings.keys().next().value;
			if (typeof oldest === "string") resource.pendingSettings.delete(oldest);
		}
		return false;
	}
	return acceptSettingsSnapshot(resource, snapshot, options);
}

function matchesActivation(
	resource: WorkspaceResource,
	event: {
		plugin_id: string;
		contribution_id: string;
		workspace_root: string;
	},
): boolean {
	const { input } = resource;
	return (
		event.plugin_id === input.pluginId &&
		event.contribution_id === input.contributionId &&
		event.workspace_root === input.workspace.root
	);
}

async function loadResource(
	resource: WorkspaceResource,
	settingsObservationError: string | null = null,
	activationObservationError: string | null = null,
) {
	const { input } = resource;
	const activationRevision = resource.activationRevision;
	const settingsLoadRevision = resource.settingsLoadRevision;
	const activation = dureIssueTrackerActivationGet({
		plugin_id: input.pluginId,
		contribution_id: input.contributionId,
		workspace_root: input.workspace.root,
	});
	const settings =
		input.settingsTarget
			? durePluginSettingsGet(
					input.settingsTarget,
					"workspace",
					resource.authoritativeWorkspaceIdentity ??
						input.workspace.scopeKey ??
						undefined,
					input.workspace.source === "local"
						? input.workspace.root
						: undefined,
				)
			: Promise.resolve(null);
	const [activationResult, settingsResult] = await Promise.allSettled([
		activation,
		settings,
	]);
	if (!resource.active) return;
	if (resource.activationRevision === activationRevision) {
		resources.publish(resource, {
			...resource.snapshot,
			activation:
				activationObservationError === null &&
				activationResult.status === "fulfilled" &&
				activationResult.value
					? "active"
					: "required",
			activationError:
				activationResult.status === "rejected"
					? String(activationResult.reason)
					: activationObservationError,
		});
	}
	if (resource.settingsLoadRevision === settingsLoadRevision) {
		const settingsExpected = input.settingsTarget !== null;
		const loadedSettings =
			settingsResult.status === "fulfilled" &&
			settingsResult.value !== null &&
			matchesSettingsTarget(resource, settingsResult.value) &&
			(resource.authoritativeWorkspaceIdentity === null ||
				settingsResult.value.scope_key ===
					resource.authoritativeWorkspaceIdentity)
				? settingsResult.value
				: null;
		const settingsReadError = !settingsExpected
			? null
			: settingsResult.status === "rejected"
				? String(settingsResult.reason)
				: loadedSettings === null
					? "plugin_settings_snapshot_target_mismatch"
					: null;
		resource.settingsObservationError = settingsObservationError;
		if (!settingsExpected) {
			resources.publish(resource, {
				...resource.snapshot,
				settings: null,
			settingsLoaded: true,
				settingsError: null,
			});
		} else if (loadedSettings === null || settingsReadError) {
			resources.publish(resource, {
				...resource.snapshot,
				settings: null,
				settingsLoaded: true,
				settingsError: settingsReadError ?? settingsObservationError,
			});
		} else {
			if (
				resource.expectedSettingsScopeKey !== null &&
				resource.expectedSettingsScopeKey !== loadedSettings.scope_key
			) {
				resource.settingsRevisionFloor = null;
				resource.settingsFingerprintAtFloor = null;
				resource.settingsPolicyEpochsAtFloor = {};
				resource.settingsInvalidatedAtRevision = null;
	}
			resource.expectedSettingsScopeKey = loadedSettings.scope_key;
			acceptSettingsSnapshot(resource, loadedSettings, { authoritative: true });
			const pending = resource.pendingSettings.get(loadedSettings.scope_key);
			resource.pendingSettings.clear();
			if (pending) acceptSettingsSnapshot(resource, pending);
}
	}
}

async function startResource(resource: WorkspaceResource) {
	let activationEventError: string | null = null;
	if (!resource.activationEventListening) {
		const activationUnlisten = await onDureIssueTrackerActivationEvent(
			(event) => {
				if (!matchesActivation(resource, event)) return;
				resource.activationRevision += 1;
				resources.publish(resource, {
					...resource.snapshot,
					activation: event.active ? "active" : "required",
					activationError: null,
				});
			},
		).catch((error) => {
			activationEventError = `issue_tracker_activation_event_subscription_failed: ${String(error)}`;
			return undefined;
		});
		if (!resource.active) {
			activationUnlisten?.();
			return;
		}
		if (activationUnlisten) {
			resource.activationEventListening = true;
			resource.unlisten.push(activationUnlisten);
		}
	}

	let settingsEventError: string | null = null;
	if (
		resource.input.settingsTarget &&
		!resource.settingsEventListening
	) {
		const settingsUnlisten = await onDurePluginSettingsEvent((snapshot) => {
				queueOrAcceptSettingsSnapshot(resource, snapshot);
			}).catch((error) => {
				settingsEventError = `plugin_settings_event_subscription_failed: ${String(error)}`;
				return undefined;
			});
		if (!resource.active) {
			settingsUnlisten?.();
			return;
		}
		if (settingsUnlisten) {
			resource.settingsEventListening = true;
			resource.unlisten.push(settingsUnlisten);
		}
	}

	if (!resource.active) return;
	// A point-in-time read becomes current workspace state only after its event
	// streams are attached. Keep retryable setup failures in the existing
	// checking state; publish an observation error only when retries are spent.
	const observationsReady =
		resource.activationEventListening &&
		(!resource.input.settingsTarget || resource.settingsEventListening);
	if (observationsReady) {
		resource.eventRetryAttempt = 0;
		await loadResource(resource);
		return;
	}

	const delay = EVENT_RETRY_DELAYS_MS[resource.eventRetryAttempt];
	if (delay !== undefined) {
		if (resource.eventRetryTimer === null) {
			resource.eventRetryAttempt += 1;
			resource.eventRetryTimer = setTimeout(() => {
				resource.eventRetryTimer = null;
				if (resource.active) void startResource(resource);
			}, delay);
		}
		return;
	}

	await loadResource(resource, settingsEventError, activationEventError);
}

function createResource(
	input: PluginIssueTrackerWorkspaceInput,
	authoritativeWorkspaceIdentity: string | null,
) {
	return {
		input,
		authoritativeWorkspaceIdentity,
		snapshot: EMPTY_SNAPSHOT,
		unlisten: [],
		activationRevision: 0,
		settingsLoadRevision: 0,
		expectedSettingsScopeKey: null,
		pendingSettings: new Map(),
		settingsObservationError: null,
		settingsRevisionFloor: null,
		settingsFingerprintAtFloor: null,
		settingsPolicyEpochsAtFloor: {},
		settingsInvalidatedAtRevision: null,
		settingsInvalidationId: null,
		activationEventListening: false,
		settingsEventListening: false,
		eventRetryAttempt: 0,
		eventRetryTimer: null,
	};
}

function disposeResource(resource: WorkspaceResource) {
	if (resource.eventRetryTimer !== null) {
		clearTimeout(resource.eventRetryTimer);
		resource.eventRetryTimer = null;
	}
	for (const unlisten of resource.unlisten) unlisten();
}

export function usePluginIssueTrackerWorkspace(
	input: PluginIssueTrackerWorkspaceInput | null,
): PluginIssueTrackerWorkspaceSnapshot {
	const permission = usePluginPermissionWorkspace(
		input
			? {
					pluginId: input.pluginId,
					workspaceRoot: input.workspace.root,
				}
			: null,
	);
	const authoritativeWorkspaceIdentity =
		permission.permission?.plan.workspace_identity ?? null;
	const stableInput = useMemo(
		() =>
			input
				? {
						pluginId: input.pluginId,
						contributionId: input.contributionId,
						settingsTarget: input.settingsTarget,
						workspace: input.workspace,
					}
				: null,
		[
			input?.contributionId,
			input?.pluginId,
			input?.settingsTarget,
			input?.workspace.root,
			input?.workspace.scopeKey,
			input?.workspace.watchKey,
		],
	);
	const key = useMemo(
		() =>
			stableInput && authoritativeWorkspaceIdentity
				? resourceKey(stableInput, authoritativeWorkspaceIdentity)
				: null,
		[authoritativeWorkspaceIdentity, stableInput],
	);
	const subscribe = useCallback(
		(listener: () => void) =>
			resources.subscribe(
				key,
				stableInput,
				listener,
				(input) =>
					createResource(input, authoritativeWorkspaceIdentity),
				startResource,
				disposeResource,
			),
		[authoritativeWorkspaceIdentity, key, stableInput],
	);
	const getSnapshot = useCallback(() => resources.snapshot(key), [key]);
	const issueTracker = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	return useMemo(() => {
		const expectedScopeKey = permission.permission?.plan.workspace_identity;
		const settingsIdentityMismatch =
			issueTracker.settings !== null &&
			expectedScopeKey !== undefined &&
			issueTracker.settings.scope_key !== expectedScopeKey;
		return {
			...issueTracker,
			...(settingsIdentityMismatch
			? {
						settings: null,
						settingsLoaded: true,
						settingsError: "plugin_settings_workspace_identity_mismatch",
				}
				: {}),
			...permission,
		};
	}, [issueTracker, permission]);
}

function clearSettingsRevalidationRetry(invalidationId: number) {
	const retry = settingsRevalidationRetries.get(invalidationId);
	if (retry?.timer) clearTimeout(retry.timer);
	settingsRevalidationRetries.delete(invalidationId);
}

function snapshotsHaveSameWinner(
	left: DurePluginSettingsSnapshot,
	right: DurePluginSettingsSnapshot,
): boolean {
	return (
		settingsRevision(left) === settingsRevision(right) &&
		settingsFingerprint(left) === settingsFingerprint(right) &&
		JSON.stringify(left.agent_claim_policy_epochs ?? {}) ===
			JSON.stringify(right.agent_claim_policy_epochs ?? {})
	);
}

export function publishPluginSettingsSnapshot(
	snapshot: DurePluginSettingsSnapshot,
	invalidation?: PluginSettingsInvalidationToken,
): PluginSettingsReconcileReceipt {
	let matchedResources = 0;
	let acceptedResources = 0;
	let current: DurePluginSettingsSnapshot | null = null;
	let conflict = false;
	for (const resource of resources.values()) {
		if (
			!matchesSettingsTarget(resource, snapshot) ||
			resource.expectedSettingsScopeKey !== snapshot.scope_key
		) {
			continue;
		}
		matchedResources += 1;
		if (
			acceptSettingsSnapshot(resource, snapshot, {
				authoritative: true,
				invalidationId: invalidation?.id,
			})
		) {
			acceptedResources += 1;
		}
		const observed = resource.snapshot.settings;
		if (observed === null) {
			conflict = true;
			continue;
		}
		if (current === null) {
			current = observed;
			continue;
		}
		const observedRevision = settingsRevision(observed);
		const currentRevision = settingsRevision(current);
		if (observedRevision === null || currentRevision === null) {
			conflict = true;
			continue;
		}
		const order = compareSettingsRevisions(observedRevision, currentRevision);
		if (order > 0) {
			current = observed;
		} else if (
			order === 0 &&
			settingsFingerprint(observed) !== settingsFingerprint(current)
		) {
			conflict = true;
		}
	}
	if (matchedResources === 0) current = snapshot;
	const candidateIsWinner =
		matchedResources === 0 ||
		(!conflict &&
			acceptedResources === matchedResources &&
			current !== null &&
			snapshotsHaveSameWinner(current, snapshot));
	return {
		candidateIsWinner,
		matchedResources,
		current,
		reason: candidateIsWinner
			? "accepted"
			: conflict || current === null
				? "conflict"
				: "superseded",
	};
}

export function invalidatePluginSettingsSnapshot(
	snapshot: DurePluginSettingsSnapshot,
): PluginSettingsInvalidationToken | null {
	const callerRevision = settingsRevision(snapshot);
	if (callerRevision === null || typeof snapshot.scope_key !== "string") {
		return null;
	}
	const invalidationId = nextSettingsInvalidationId;
	nextSettingsInvalidationId += 1;
	const matchingResources = [...resources.values()].filter(
		(resource) =>
			matchesSettingsTarget(resource, snapshot) &&
			resource.expectedSettingsScopeKey === snapshot.scope_key,
	);
	if (matchingResources.length === 0) return null;
	const workspaceRoots = new Set(
		matchingResources.map((resource) => resource.input.workspace.root),
	);
	if (workspaceRoots.size !== 1) return null;
	const workspaceRoot = workspaceRoots.values().next().value;
	if (!workspaceRoot) return null;
	for (const resource of matchingResources) {
		const currentRevision = resource.settingsRevisionFloor;
		const authorityFloor = maxSettingsRevision(
			currentRevision,
			resource.settingsInvalidatedAtRevision,
		);
		if (
			authorityFloor !== null &&
			compareSettingsRevisions(callerRevision, authorityFloor) < 0
		) {
			return null;
}
		if (
			resource.settingsInvalidatedAtRevision !== null &&
			compareSettingsRevisions(
				callerRevision,
				resource.settingsInvalidatedAtRevision,
			) <= 0
		) {
			return null;
		}
		if (
			currentRevision !== null &&
			compareSettingsRevisions(callerRevision, currentRevision) === 0 &&
			resource.settingsFingerprintAtFloor !== settingsFingerprint(snapshot)
		) {
			publishSettingsConflict(resource);
			return null;
		}
	}
	for (const resource of matchingResources) {
		const currentRevision = resource.settingsRevisionFloor;
		if (
			currentRevision === null ||
			compareSettingsRevisions(callerRevision, currentRevision) > 0
		) {
			resource.settingsRevisionFloor = callerRevision;
			resource.settingsFingerprintAtFloor = settingsFingerprint(snapshot);
		}
		resource.settingsPolicyEpochsAtFloor = mergeSettingsPolicyEpochs(
			resource.settingsPolicyEpochsAtFloor,
			snapshot.agent_claim_policy_epochs,
		);
		resource.settingsLoadRevision += 1;
		resource.settingsInvalidatedAtRevision = maxSettingsRevision(
			resource.settingsInvalidatedAtRevision,
			resource.settingsRevisionFloor,
			callerRevision,
		);
		if (resource.settingsInvalidationId !== null) {
			clearSettingsRevalidationRetry(resource.settingsInvalidationId);
		}
		resource.settingsInvalidationId = invalidationId;
		resources.publish(resource, {
			...resource.snapshot,
			settings: null,
			settingsLoaded: true,
			settingsError: "plugin_settings_revalidation_required",
		});
	}
	return {
		id: invalidationId,
		target: snapshot.target,
		scopeKey: snapshot.scope_key,
		workspaceRoot,
	};
}

function scheduleSettingsRevalidation(token: PluginSettingsInvalidationToken) {
	const stillCurrent = [...resources.values()].some(
		(resource) =>
			resource.active && resource.settingsInvalidationId === token.id,
	);
	if (!stillCurrent) {
		clearSettingsRevalidationRetry(token.id);
		return;
	}
	const retry = settingsRevalidationRetries.get(token.id) ?? {
		attempt: 0,
		timer: null,
		token,
	};
	if (retry.timer !== null) return;
	const delay = EVENT_RETRY_DELAYS_MS[retry.attempt];
	if (delay === undefined) return;
	retry.attempt += 1;
	retry.timer = setTimeout(() => {
		retry.timer = null;
		void revalidatePluginSettingsSnapshot(retry.token);
	}, delay);
	settingsRevalidationRetries.set(token.id, retry);
}

export async function revalidatePluginSettingsSnapshot(
	token: PluginSettingsInvalidationToken,
): Promise<PluginSettingsReconcileReceipt> {
	try {
		const loaded = await durePluginSettingsGet(
			token.target,
			"workspace",
			token.scopeKey,
			token.workspaceRoot,
		);
		if (
			!pluginSettingsTargetsEqual(loaded.target, token.target) ||
			loaded.scope !== "workspace" ||
			loaded.scope_key !== token.scopeKey
		) {
			throw new Error("plugin_settings_snapshot_target_mismatch");
		}
		const receipt = publishPluginSettingsSnapshot(loaded, token);
		if (receipt.reason !== "conflict") {
			clearSettingsRevalidationRetry(token.id);
		}
		return receipt;
	} catch {
		scheduleSettingsRevalidation(token);
		return {
			candidateIsWinner: false,
			matchedResources: [...resources.values()].filter(
				(resource) => resource.settingsInvalidationId === token.id,
			).length,
			current: null,
			reason: "revalidation_failed",
		};
	}
}

export function resetPluginIssueTrackerWorkspaceResourcesForTests() {
	resources.reset(disposeResource);
	for (const retry of settingsRevalidationRetries.values()) {
		if (retry.timer) clearTimeout(retry.timer);
	}
	settingsRevalidationRetries.clear();
	nextSettingsInvalidationId = 1;
	resetPluginPermissionWorkspaceResourcesForTests();
}
