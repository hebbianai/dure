import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
	IssueTrackerIssueSummaryV1,
	IssueTrackerWatchEventV1,
} from "@/contracts/generated/extensionContracts";
import {
	dureIssueTrackerQuery,
	dureIssueTrackerWatchSubscribe,
	dureIssueTrackerWatchUnsubscribe,
	onDureIssueTrackerWatchEvent,
} from "@/lib/ipc";
import type { IssueTrackerClaimProjectionInput } from "@/lib/plugins/issueTrackerClaimConfiguration";
import {
	issueTrackerWatchSubscriberId,
	nextIssueTrackerSubscriberEpoch,
	releaseIssueTrackerWatchLease,
} from "@/lib/plugins/issueTrackerWatchLease";
import { IssueTrackerWatchReceiver } from "@/lib/plugins/issueTrackerWatchReceiver";
import { KeyedExternalStoreRegistry } from "@/lib/plugins/keyedExternalStoreRegistry";

export interface IssueTrackerClaimProjectionSnapshot {
	issues: IssueTrackerIssueSummaryV1[];
	complete: boolean;
	loading: boolean;
	error: string | null;
}

interface ClaimResource {
	input: IssueTrackerClaimProjectionInput;
	snapshot: IssueTrackerClaimProjectionSnapshot;
	observationSnapshot: IssueTrackerClaimProjectionSnapshot;
	listeners: Set<() => void>;
	active: boolean;
	/** True between the last listener leaving and either a listener returning
	 * inside the disposal grace or disposal itself. A suspended resource keeps
	 * its snapshot but holds no watcher lease, so a hidden Space or pane never
	 * keeps a backend cycle running. */
	suspended: boolean;
	unlisten?: () => void;
	cancelSubscribeRetry?: () => void;
	lease: ClaimWatcherLease | null;
	subscriberId: string;
	watchError: string | null;
	freshnessFence: number;
}

interface ClaimWatcherLease {
	subscriberEpoch: number;
	receiver: IssueTrackerWatchReceiver;
	releaseAttempt: "unresolved-generation" | number | null;
}

const EMPTY_SNAPSHOT: IssueTrackerClaimProjectionSnapshot = {
	issues: [],
	complete: false,
	loading: false,
	error: null,
};
const LOADING_SNAPSHOT: IssueTrackerClaimProjectionSnapshot = {
	...EMPTY_SNAPSHOT,
	loading: true,
};
const SUBSCRIBE_RETRY_DELAYS_MS = [250, 1_000, 5_000] as const;
/** Pane tab switches and Space switches unmount the last chip before the
 * next one mounts. Keeping the projection for a minute turns that gap into
 * a resume instead of a foreground query plus a full initial watch cycle. */
const DISPOSAL_GRACE_MS = 60_000;
const resources = new KeyedExternalStoreRegistry<
	IssueTrackerClaimProjectionSnapshot,
	ClaimResource
>(EMPTY_SNAPSHOT);

function normalizedStatuses(statuses: readonly string[]): string[] {
	return [...statuses].sort();
}

function resourceKey(input: IssueTrackerClaimProjectionInput): string {
	return JSON.stringify([
		input.pluginId,
		input.viewContributionId,
		input.viewId,
		input.contributionId,
		input.workspace.root,
		input.workspace.watchKey,
		normalizedStatuses(input.statuses),
		input.watchEnabled,
		input.intervalSeconds,
		input.agentClaimPolicyEpoch,
	]);
}

function logicalSubscriberIdentity(
	input: IssueTrackerClaimProjectionInput,
): readonly unknown[] {
	return [
		input.pluginId,
		input.viewContributionId,
		input.viewId,
		input.contributionId,
		input.workspace.root,
		input.workspace.watchKey,
		normalizedStatuses(input.statuses),
	];
}

function releaseClaimWatcher(
	resource: ClaimResource,
	lease: ClaimWatcherLease | null = resource.lease,
) {
	if (!lease) return;
	const generation = lease.receiver.generation;
	const releaseAttempt = generation ?? "unresolved-generation";
	if (lease.releaseAttempt === releaseAttempt) return;
	lease.releaseAttempt = releaseAttempt;
	void releaseIssueTrackerWatchLease(dureIssueTrackerWatchUnsubscribe, {
		plugin_id: resource.input.pluginId,
		contribution_id: resource.input.contributionId,
		workspace_root: resource.input.workspace.root,
		subscriber_id: resource.subscriberId,
		subscriber_epoch: lease.subscriberEpoch,
		...(generation === null ? {} : { generation }),
	});
}

function applyWatchEvent(
	resource: ClaimResource,
	event: IssueTrackerWatchEventV1,
) {
	if (event.state.kind === "snapshot") {
		const watched = event.state.snapshot.agent_claim_issues;
		if (!watched) return;
		resource.freshnessFence += 1;
		const statuses = new Set(resource.input.statuses);
		publishObservation(resource, {
			issues: watched.filter((issue) => statuses.has(issue.status)),
			complete: event.state.snapshot.agent_claim_issues_complete === true,
			loading: false,
			error: null,
		});
		return;
	}
	resource.freshnessFence += 1;
	publishObservation(resource, {
		...resource.observationSnapshot,
		loading: false,
		error: event.state.code,
	});
}

function receiveWatchEvent(
	resource: ClaimResource,
	event: IssueTrackerWatchEventV1,
) {
	if (!resource.active || resource.suspended) return;
	const accepted = resource.lease?.receiver.receive(event);
	if (accepted) applyWatchEvent(resource, accepted);
}

function projectionForWatchState(
	resource: ClaimResource,
	observation: IssueTrackerClaimProjectionSnapshot,
): IssueTrackerClaimProjectionSnapshot {
	if (!resource.input.watchEnabled || resource.watchError === null) {
		return observation;
	}
	return {
		...observation,
		complete: false,
		error: resource.watchError,
	};
}

function publishObservation(
	resource: ClaimResource,
	observation: IssueTrackerClaimProjectionSnapshot,
) {
	resource.observationSnapshot = observation;
	resources.publish(resource, projectionForWatchState(resource, observation));
}

function publishWatchFailure(resource: ClaimResource, error: string) {
	resource.watchError = error;
	resources.publish(
		resource,
		projectionForWatchState(resource, resource.observationSnapshot),
	);
}

function publishWatchRecovery(resource: ClaimResource) {
	resource.watchError = null;
	resources.publish(resource, resource.observationSnapshot);
}

function waitForSubscribeRetry(
	resource: ClaimResource,
	delayMs: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resource.cancelSubscribeRetry = undefined;
			resolve(true);
		}, delayMs);
		resource.cancelSubscribeRetry = () => {
			clearTimeout(timer);
			resource.cancelSubscribeRetry = undefined;
			resolve(false);
		};
	});
}

async function subscribeClaimWatcher(resource: ClaimResource) {
	for (let attempt = 0; resource.active && !resource.suspended; attempt += 1) {
		const lease: ClaimWatcherLease = {
			subscriberEpoch: nextIssueTrackerSubscriberEpoch(),
			receiver:
				resource.lease?.receiver.renew() ??
				new IssueTrackerWatchReceiver({
					pluginId: resource.input.pluginId,
					contributionId: resource.input.contributionId,
					workspaceKey: resource.input.workspace.watchKey,
				}),
			releaseAttempt: null,
		};
		resource.lease = lease;
		try {
			const subscription = await dureIssueTrackerWatchSubscribe({
				plugin_id: resource.input.pluginId,
				contribution_id: resource.input.contributionId,
				workspace_key: resource.input.workspace.watchKey,
				workspace_root: resource.input.workspace.root,
				subscriber_id: resource.subscriberId,
				subscriber_epoch: lease.subscriberEpoch,
				interval_seconds: resource.input.intervalSeconds,
				include_agent_claims: true,
				agent_claim_policy_epoch: resource.input.agentClaimPolicyEpoch,
			});
			const accepted = lease.receiver.acknowledge(subscription);
			if (!resource.active || resource.suspended || resource.lease !== lease) {
				releaseClaimWatcher(resource, lease);
				return;
			}
			publishWatchRecovery(resource);
			for (const event of accepted) applyWatchEvent(resource, event);
			return;
		} catch (error) {
			releaseClaimWatcher(resource, lease);
			if (!resource.active || resource.suspended || resource.lease !== lease) {
				return;
			}
			publishWatchFailure(
				resource,
				`issue_tracker_watch_subscribe_failed: ${String(error)}`,
			);
			const retryDelay = SUBSCRIBE_RETRY_DELAYS_MS[attempt];
			if (retryDelay === undefined) return;
			if (!(await waitForSubscribeRetry(resource, retryDelay))) return;
		}
	}
}

function startForegroundQuery(resource: ClaimResource) {
	const queryFence = resource.freshnessFence;
	void dureIssueTrackerQuery({
		plugin_id: resource.input.pluginId,
		contribution_id: resource.input.contributionId,
		workspace_root: resource.input.workspace.root,
		agent_claim_policy_epoch: resource.input.agentClaimPolicyEpoch,
		query: {
			kind: "agent_claims",
			statuses: resource.input.statuses,
			limit: 100,
		},
	})
		.then((result) => {
			if (
				!resource.active ||
				resource.freshnessFence !== queryFence ||
				result.kind !== "list"
			) {
				return;
			}
			publishObservation(resource, {
				issues: result.issues,
				complete: result.complete === true,
				loading: false,
				error: null,
			});
		})
		.catch((error) => {
			if (!resource.active || resource.freshnessFence !== queryFence) return;
			publishObservation(resource, {
				...resource.observationSnapshot,
				complete: false,
				loading: false,
				error: String(error),
			});
		});
}

async function startResource(resource: ClaimResource) {
	startForegroundQuery(resource);
	if (!resource.input.watchEnabled) return;
	let stopListening: (() => void) | undefined;
	for (let attempt = 0; resource.active; attempt += 1) {
		try {
			stopListening = await onDureIssueTrackerWatchEvent((event) =>
				receiveWatchEvent(resource, event),
			);
			break;
		} catch (error) {
			if (!resource.active) return;
			publishWatchFailure(
				resource,
				`issue_tracker_watch_listener_failed: ${String(error)}`,
			);
			const retryDelay = SUBSCRIBE_RETRY_DELAYS_MS[attempt];
			if (retryDelay === undefined) return;
			if (!(await waitForSubscribeRetry(resource, retryDelay))) return;
		}
	}
	if (!resource.active) {
		stopListening?.();
		return;
	}
	resource.unlisten = stopListening;
	if (stopListening && !resource.suspended) {
		await subscribeClaimWatcher(resource);
	}
}

function suspendResource(resource: ClaimResource) {
	resource.suspended = true;
	resource.cancelSubscribeRetry?.();
	releaseClaimWatcher(resource);
	// Retain only the released receipt's cursor for a possible reused
	// generation. The next subscribe owns a fresh epoch and acknowledgement.
}

function resumeResource(resource: ClaimResource) {
	if (!resource.suspended) return;
	resource.suspended = false;
	// The retained snapshot renders immediately; only the watcher lease is
	// re-acquired. When another window still holds the watcher the backend
	// answers with `reused_watcher` and its latest event, otherwise the fresh
	// watcher's first cycle refreshes the projection.
	if (resource.input.watchEnabled && resource.unlisten) {
		void subscribeClaimWatcher(resource);
	}
}

const DISPOSAL_GRACE = {
	graceMs: DISPOSAL_GRACE_MS,
	resume: resumeResource,
	suspend: suspendResource,
};

function createResource(input: IssueTrackerClaimProjectionInput) {
	return {
		input: { ...input, statuses: normalizedStatuses(input.statuses) },
		snapshot: LOADING_SNAPSHOT,
		observationSnapshot: LOADING_SNAPSHOT,
		suspended: false,
		lease: null,
		subscriberId: issueTrackerWatchSubscriberId(
			"plugin-agent-claims",
			logicalSubscriberIdentity(input),
		),
		watchError: null,
		freshnessFence: 0,
	};
}

function disposeResource(resource: ClaimResource) {
	resource.unlisten?.();
	resource.cancelSubscribeRetry?.();
	releaseClaimWatcher(resource);
}

export function useIssueTrackerClaimProjection(
	input: IssueTrackerClaimProjectionInput | null,
): IssueTrackerClaimProjectionSnapshot {
	const stableInput = useMemo(
		() =>
			input ? { ...input, statuses: normalizedStatuses(input.statuses) } : null,
		[
			input?.agentClaimPolicyEpoch,
			input?.contributionId,
			input?.intervalSeconds,
			input?.pluginId,
			input?.statuses,
			input?.viewContributionId,
			input?.viewId,
			input?.watchEnabled,
			input?.workspace,
		],
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
				disposeResource,
				DISPOSAL_GRACE,
			),
		[key, stableInput],
	);
	const getSnapshot = useCallback(() => resources.snapshot(key), [key]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function resetIssueTrackerClaimProjectionResourcesForTests() {
	resources.reset(disposeResource);
}
