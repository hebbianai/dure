import type { NotificationPaneTarget } from "@/lib/ipc/notifications";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";

export interface NotificationPaneLookup {
	getPanel(panelId: string): unknown | undefined;
}

export function selectNotificationPaneTarget(
	preferredDesktopId: string,
	targets: readonly NotificationPaneTarget[],
): NotificationPaneTarget | undefined {
	const unique = [
		...new Map(
			targets.map(({ desktopId, panelId }) => [
				JSON.stringify([desktopId, panelId]),
				{ desktopId, panelId },
			]),
		).values(),
	];
	const preferred = unique.filter(
		(target) => target.desktopId === preferredDesktopId,
	);
	return preferred.length === 1
		? preferred[0]
		: unique.length === 1
			? unique[0]
			: undefined;
}

/**
 * 알림을 만든 시점의 pane 소유 desktop을 확정한다. mount된 Dockview가 최신
 * 사실이고, 없을 때만 영속 layout을 본다. 후보가 여러 개면 호출자가 준 우선
 * desktop 외에는 추측하지 않는다 — 알림 클릭이 엉뚱한 agent를 앞으로 가져오는
 * 것보다 안전하다.
 */
export function resolveNotificationPaneTarget(
	panelId: string,
	preferredDesktopId: string,
	layouts: Readonly<Record<string, unknown>>,
	mounted: readonly (readonly [string, NotificationPaneLookup])[],
): NotificationPaneTarget | undefined {
	const mountedDesktopIds = mounted
		.filter(([, api]) => api.getPanel(panelId) !== undefined)
		.map(([desktopId]) => desktopId);
	if (mountedDesktopIds.length > 0) {
		return selectNotificationPaneTarget(
			preferredDesktopId,
			mountedDesktopIds.map((desktopId) => ({ desktopId, panelId })),
		);
	}

	return selectNotificationPaneTarget(
		preferredDesktopId,
		Object.entries(layouts)
			.filter(([, layout]) =>
				panelsFromLayout(layout).some((panel) => panel.id === panelId),
			)
			.map(([desktopId]) => ({ desktopId, panelId })),
	);
}
