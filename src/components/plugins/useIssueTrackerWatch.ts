import { useEffect, useRef } from "react";
import type { IssueTrackerWatchEventV1 } from "@/contracts/generated/extensionContracts";
import {
	dureIssueTrackerWatchSubscribe,
	dureIssueTrackerWatchUnsubscribe,
	onDureIssueTrackerWatchEvent,
} from "@/lib/ipc";
import {
	nextIssueTrackerSubscriberEpoch,
	releaseIssueTrackerWatchLease,
} from "@/lib/plugins/issueTrackerWatchLease";
import { IssueTrackerWatchReceiver } from "@/lib/plugins/issueTrackerWatchReceiver";

interface IssueTrackerWatchWorkspace {
	root: string;
	watchKey: string;
}

export function useIssueTrackerWatch({
	enabled,
	pluginId,
	contributionId,
	workspace,
	subscriberId,
	intervalSeconds,
	includeAgentClaims,
	onEvent,
}: {
	enabled: boolean;
	pluginId: string;
	contributionId: string;
	workspace: IssueTrackerWatchWorkspace | null;
	subscriberId: string;
	intervalSeconds: number;
	includeAgentClaims: boolean;
	onEvent: (event: IssueTrackerWatchEventV1) => void;
}) {
	const onEventRef = useRef(onEvent);
	onEventRef.current = onEvent;
	// Workspace projections are recreated on pane focus. Only the backend
	// watch identity may replace this lease.
	const workspaceRoot = workspace?.root ?? null;
	const workspaceWatchKey = workspace?.watchKey ?? null;

	useEffect(() => {
		if (!enabled || !workspaceRoot || !workspaceWatchKey) return;
		let active = true;
		let unlisten: (() => void) | undefined;
		let subscriptionAttempted = false;
		const receiver = new IssueTrackerWatchReceiver({
			pluginId,
			contributionId,
			workspaceKey: workspaceWatchKey,
		});
		const subscriberEpoch = nextIssueTrackerSubscriberEpoch();
		const releaseLease = () => {
			if (!subscriptionAttempted) return;
			const generation = receiver.generation;
			void releaseIssueTrackerWatchLease(dureIssueTrackerWatchUnsubscribe, {
				plugin_id: pluginId,
				contribution_id: contributionId,
				workspace_root: workspaceRoot,
				subscriber_id: subscriberId,
				subscriber_epoch: subscriberEpoch,
				...(generation === null ? {} : { generation }),
			});
		};

		void (async () => {
			try {
				const receiveEvent = (event: IssueTrackerWatchEventV1) => {
					if (!active) return;
					const accepted = receiver.receive(event);
					if (accepted) onEventRef.current(accepted);
				};
				const stopListening = await onDureIssueTrackerWatchEvent(receiveEvent);
				if (!active) {
					stopListening();
					return;
				}
				unlisten = stopListening;
				subscriptionAttempted = true;
				const subscription = await dureIssueTrackerWatchSubscribe({
					plugin_id: pluginId,
					contribution_id: contributionId,
					workspace_key: workspaceWatchKey,
					workspace_root: workspaceRoot,
					subscriber_id: subscriberId,
					subscriber_epoch: subscriberEpoch,
					interval_seconds: intervalSeconds,
					include_agent_claims: includeAgentClaims,
				});
				const accepted = receiver.acknowledge(subscription);
				if (active) {
					for (const event of accepted) onEventRef.current(event);
				}
				if (!active) {
					releaseLease();
				}
			} catch {
				unlisten?.();
				unlisten = undefined;
				releaseLease();
				// Foreground queries remain available when the watcher cannot start.
			}
		})();

		return () => {
			active = false;
			unlisten?.();
			releaseLease();
		};
	}, [
		contributionId,
		enabled,
		intervalSeconds,
		includeAgentClaims,
		pluginId,
		subscriberId,
		workspaceRoot,
		workspaceWatchKey,
	]);
}
