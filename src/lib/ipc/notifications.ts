// ipc/notifications — Dure 네이티브 알림 권한·전송 receipt.
// invoke 래퍼는 architecture fitness 규칙에 따라 ipc 경계만 소유한다.

import { invoke } from "@tauri-apps/api/core";
import {
	isPermissionGranted,
	requestPermission as requestPluginPermission,
} from "@tauri-apps/plugin-notification";
import { isMacPlatform } from "@/lib/workspace/desktop/desktopPlatform";

export const pushAgentNotification = (event: {
	kind: "approval" | "done";
	eventId: string;
}) => invoke<void>("hub_push_agent_notification", { event });

export type NotificationAuthorization =
	| "authorized"
	| "denied"
	| "not-determined"
	| "unknown";

export type NotificationSender =
	| "dure-app"
	| "dure-installed-bridge"
	| "unknown";

export type NotificationPresentation =
	| "temporary"
	| "persistent"
	| "disabled"
	| "unknown";

export interface NativeNotificationStatus {
	authorization: NotificationAuthorization;
	sender: NotificationSender;
	bundleIdentifier: string;
	presentation: NotificationPresentation;
	detail?: string | null;
}

export interface NotificationDispatchReceipt extends NativeNotificationStatus {
	accepted: boolean;
	reason?:
		| "permission-denied"
		| "permission-not-requested"
		| "duplicate-event"
		| "dispatch-failed"
		| "backend-error"
		| null;
}

export interface NotificationPaneTarget {
	windowLabel?: string;
	desktopId: string;
	panelId: string;
}

export interface NotificationActivation {
	activationId: string;
	paneTarget: NotificationPaneTarget;
}

export type NotificationClickQaScenario =
	| "cold-start"
	| "minimized"
	| "multi-window"
	| "owner-change";

export type NotificationClickQaPresentation =
	| "terminating"
	| "minimized"
	| "hidden";

export interface NotificationClickQaContext {
	runId: string;
	scenario: NotificationClickQaScenario;
	paneTarget: NotificationPaneTarget;
	expectedTarget: NotificationPaneTarget;
	initialDesktopId: string;
	initialPanelId: string;
	authorize: boolean;
	stage?: NotificationClickQaStage;
}

export type NotificationClickQaStage =
	| "preparing"
	| "dispatched"
	| "armed"
	| "completed"
	| "skipped"
	| "failed";

export interface NotificationClickQaJournal {
	stage: NotificationClickQaStage;
	reason?: string | null;
}

export interface NotificationClickQaObservation {
	windowLabel: string;
	activeSpaceId: string;
	/** @deprecated Use `activeSpaceId`. */
	activeDesktopId?: string;
	panelId: string;
	panelActiveCount: number;
	activationQueueEmpty: boolean;
	window: {
		visible: boolean;
		minimized: boolean;
		focused: boolean;
	};
}

export const NOTIFICATION_ACTIVATION_AVAILABLE_EVENT =
	"notification:activation-available";

export const notificationStatus = async () => {
	const status = await invoke<NativeNotificationStatus>("notification_status");
	if (isMacPlatform()) return status;
	const granted = await isPermissionGranted();
	return {
		...status,
		authorization: granted ? ("authorized" as const) : status.authorization,
	};
};

export const notificationRequestAuthorization = async () => {
	const status = await invoke<NativeNotificationStatus>(
		"notification_request_authorization",
	);
	if (isMacPlatform()) return status;
	const permission = await requestPluginPermission();
	return {
		...status,
		authorization:
			permission === "granted"
				? ("authorized" as const)
				: permission === "denied"
					? ("denied" as const)
					: ("not-determined" as const),
	};
};

export const notificationDispatch = (
	title: string,
	body: string,
	sound?: string,
	eventId?: string,
	paneTarget?: NotificationPaneTarget,
) =>
	invoke<NotificationDispatchReceipt>("notification_dispatch", {
		title,
		body,
		sound: sound || null,
		...(eventId ? { eventId } : {}),
		...(paneTarget ? { paneTarget } : {}),
	});

export const notificationActivationTake = () =>
	invoke<NotificationActivation | null>("notification_activation_take");

export const notificationOpenSettings = () =>
	invoke<void>("notification_open_settings");

export const notificationClickQaContext = () =>
	invoke<NotificationClickQaContext>("notification_click_qa_context");

export const notificationClickQaTargetReady = (runId: string) =>
	invoke<void>("notification_click_qa_target_ready", { runId });

export const notificationClickQaTargetIsReady = (
	runId: string,
	windowLabel: string,
) =>
	invoke<boolean>("notification_click_qa_target_is_ready", {
		runId,
		windowLabel,
	});

export const notificationClickQaAuthorize = (runId: string) =>
	invoke<string>("notification_click_qa_authorize", {
		runId,
		explicitUserOptIn: true,
	});

export const notificationClickQaBegin = (
	runId: string,
	scenario: NotificationClickQaScenario,
) =>
	invoke<NotificationClickQaJournal>("notification_click_qa_begin", {
		runId,
		scenario,
	});

export const notificationClickQaArm = (
	runId: string,
	presentation: NotificationClickQaPresentation,
	activePanelId: string,
) =>
	invoke<NotificationClickQaJournal>("notification_click_qa_arm", {
		runId,
		presentation,
		activePanelId,
	});

export const notificationClickQaComplete = (
	runId: string,
	observation: NotificationClickQaObservation,
) =>
	invoke<NotificationClickQaJournal>("notification_click_qa_complete", {
		runId,
		observation,
	});

export const notificationClickQaFail = (runId: string, reason: string) =>
	invoke<NotificationClickQaJournal>("notification_click_qa_fail", {
		runId,
		reason,
	});

export const notificationClickQaExit = (runId: string) =>
	invoke<void>("notification_click_qa_exit", { runId });

/** IPC 자체 실패도 호출자에게 typed receipt로 돌려준다. 알림 이벤트는 대부분
 * fire-and-forget이므로 reject를 그대로 두면 사용자에게도, 진단 화면에도 안 보인다. */
export function notificationBackendFailure(
	error: unknown,
): NotificationDispatchReceipt {
	return {
		accepted: false,
		authorization: "unknown",
		sender: "unknown",
		bundleIdentifier: "io.hebbian.ade",
		presentation: "unknown",
		reason: "backend-error",
		detail: String(error),
	};
}
