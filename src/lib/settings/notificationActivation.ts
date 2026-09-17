import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	NOTIFICATION_ACTIVATION_AVAILABLE_EVENT,
	type NotificationActivation,
	notificationActivationTake,
} from "@/lib/ipc/notifications";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { resolveNotificationPaneTarget } from "@/lib/settings/notificationPaneTarget";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { navigateToPanel } from "@/lib/workspace/dock/panelFocusHandoff";
import { useStore } from "@/store";

/** 현재 pane 소유권을 다시 검증한 뒤 메인 창과 정확한 pane을 앞으로 가져온다. */
export async function focusNotificationActivation(
	activation: NotificationActivation,
): Promise<boolean> {
	const window = getCurrentWindow();
	if (
		activation.paneTarget.windowLabel &&
		activation.paneTarget.windowLabel !== window.label
	) {
		return false;
	}
	const state = useStore.getState();
	const target = resolveNotificationPaneTarget(
		activation.paneTarget.panelId,
		activation.paneTarget.desktopId,
		state.layouts,
		mountedDockviewEntries(),
	);
	if (!target) return false;
	await window.show().catch(() => {});
	await window.unminimize().catch(() => {});
	await window.setFocus().catch(() => {});
	if (target) navigateToPanel(target.desktopId, target.panelId);
	return true;
}

/**
 * 네이티브 delegate의 bounded queue를 소비한다. listener를 먼저 설치한 뒤 queue를
 * drain하므로, 종료 상태에서 알림을 눌러 앱이 부팅되는 경우에도 신호가 유실되지
 * 않는다. event payload는 wake-up일 뿐이고 실제 route의 권위는 take IPC다.
 */
export function installNotificationActivationHandler(): () => void {
	let disposed = false;
	let unlisten: (() => void) | undefined;
	let draining = false;
	let drainAgain = false;

	const drain = async () => {
		if (draining) {
			drainAgain = true;
			return;
		}
		draining = true;
		try {
			do {
				drainAgain = false;
				while (!disposed) {
					const activation = await notificationActivationTake();
					if (!activation) break;
					await focusNotificationActivation(activation);
				}
			} while (!disposed && drainAgain);
		} catch (error) {
			console.warn("[notification] failed to open notification click target", error);
		} finally {
			draining = false;
		}
	};

	void listenWhenReady(NOTIFICATION_ACTIVATION_AVAILABLE_EVENT, () => {
		void drain();
	})
		.then((dispose) => {
			if (disposed) dispose();
			else {
				unlisten = dispose;
				void drain();
			}
		})
		.catch((error) => {
			console.warn(
				"[notification] failed to install notification click listener",
				error,
			);
		});

	return () => {
		disposed = true;
		unlisten?.();
	};
}
