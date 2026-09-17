import type { DockviewApi } from "dockview-react";
import {
	dockPanelReference,
	findAgentPanel,
} from "@/lib/workspace/dock/dockPanelParameters";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import {
	panelsFromLayout,
	type SerializedPanelRef,
} from "@/lib/workspace/layout/layoutLifecycle";

/** A mounted Space replaces its saved projection, including removed content.
 * This is a presentation lookup; it neither discovers nor creates a runtime. */
export function agentPaneLocations(
	layouts: Readonly<Record<string, unknown>>,
	mounted: Iterable<readonly [string, Pick<DockviewApi, "panels">]> = [],
): { agentId: string; desktopId: string; panelId: string }[] {
	const panesByDesktop = new Map<string, readonly SerializedPanelRef[]>();
	for (const [desktopId, api] of mounted) {
		panesByDesktop.set(desktopId, api.panels.map(dockPanelReference));
	}
	for (const [desktopId, layout] of Object.entries(layouts)) {
		if (!panesByDesktop.has(desktopId))
			panesByDesktop.set(desktopId, panelsFromLayout(layout));
	}
	return [...panesByDesktop].flatMap(([desktopId, panes]) =>
		panes.flatMap((pane) => {
			const agentId = agentIdFromPane(pane);
			return agentId === undefined
				? []
				: [{ agentId, desktopId, panelId: pane.id }];
		}),
	);
}

export function selectUnopenedAgents<T extends { readonly id: string }>(
	agents: readonly T[],
	openAgentIds: ReadonlySet<string>,
): T[] {
	return agents.filter((agent) => !openAgentIds.has(agent.id));
}

/** Mounted panes remain authoritative while persisted layouts lag behind.
 * Hidden grid panes are still mounted and must not become cleanup candidates. */
export function isAgentPaneMounted(
	agentId: string,
	entries: Iterable<readonly [string, Pick<DockviewApi, "panels">]>,
): boolean {
	for (const [, api] of entries) {
		if (findAgentPanel(api, agentId)) return true;
	}
	return false;
}

/** "사용자가 이 pane을 보고 있는가" — 알림 억제와 unread ack가 같은 술어를
 *  써야 한다. isActive는 "자기 그룹 안에서 활성 탭"일 뿐이라(다른 그룹 최대화
 *  시에도 true) isVisible을 함께 본다. */
export function isPanelApiInView(
	api: { readonly isActive: boolean; readonly isVisible: boolean } | undefined,
	hasFocus: boolean,
): boolean {
	return Boolean(api?.isActive && api.isVisible && hasFocus);
}
