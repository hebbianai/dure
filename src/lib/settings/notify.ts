import {
	type NotificationDispatchReceipt,
	type NotificationPaneTarget,
	notificationBackendFailure,
	notificationDispatch,
} from "@/lib/ipc/notifications";
import { notificationSoundForDispatch } from "@/lib/settings/notifyPrefs";
import { DEFAULT_NOTIFY_PREFS, type NotifyPrefs, useStore } from "@/store";

/** 현재 알림 설정 (구버전 저장분은 기본값과 병합). */
export function notifyPrefs(): NotifyPrefs {
	return { ...DEFAULT_NOTIFY_PREFS, ...useStore.getState().notifyPrefs };
}

/** Dure 신원으로 시스템 알림을 요청하고 OS adapter receipt를 돌려준다. */
export function systemNotify(
	title: string,
	body: string,
	options?: { eventId?: string; paneTarget?: NotificationPaneTarget },
): Promise<NotificationDispatchReceipt> {
	const sound = notificationSoundForDispatch(notifyPrefs().sound);
	return notificationDispatch(
		title,
		body,
		sound,
		options?.eventId,
		options?.paneTarget,
	).catch(notificationBackendFailure);
}
