// 분할 실행 — resolvePaneSplitTarget이 고른 대상으로 새 pane을 연다.
// 대상 결정(순수)과 여는 동작(dock 의존)을 갈라 둔 이유는, 탭 헤더·터미널
// 우클릭·단축키가 모두 같은 결정 함수를 쓰되 각자 쥔 api/desktopId로 열 수
// 있어야 하기 때문이다.

import type { DockviewApi } from "dockview-react";
import { t } from "@/lib/i18n";
import {
	createLocalTerminalOn,
	openRemoteSshTerminalOn,
} from "@/lib/workspace/dock";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { openOrFocusPanel } from "@/lib/workspace/dock/openOrFocusPanel";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import type { PaneSplitTarget } from "@/lib/workspace/pane/paneSplitTarget";

export { paneSplitTargetForPanel } from "@/lib/workspace/pane/paneSplitFromParams";

import { useStore } from "@/store";

/** Generic split reserves a pane; choosing its content owns session creation. */
export function openSplitLauncherOn(
	api: DockviewApi,
	target: PaneSplitTarget,
	position: PanelPosition,
): void {
	openOrFocusPanel({
		api,
		panelId: createPaneId(),
		component: "launcher",
		title: t("workspace.launcher.title"),
		params: {
			cwd: target.cwd,
			...(target.kind === "ssh" ? { hostId: target.hostId } : {}),
		},
		position,
	});
}

export function openSplitLauncherPanel(
	desktopId: string,
	target: PaneSplitTarget,
	position: PanelPosition,
): void {
	const api = getDockview(desktopId);
	if (api) openSplitLauncherOn(api, target, position);
}

export function openSplitTerminalOn(
	api: DockviewApi,
	target: PaneSplitTarget,
	position?: PanelPosition,
): Promise<void> {
	if (target.kind === "ssh") {
		const host = useStore
			.getState()
			.sshHosts.find((candidate) => candidate.id === target.hostId);
		// 호스트가 지워졌어도 조용히 로컬 셸로 바꿔치지 않는다 — 원격 열기가
		// "호스트 미등록" 토스트로 정확히 실패해, 원격에서 분할한 사용자가 그
		// 사실을 모른 채 로컬 명령을 치는 일을 막는다.
		return openRemoteSshTerminalOn(
			api,
			target.hostId,
			host?.name ?? "ssh",
			target.cwd,
			position,
		);
	}
	return createLocalTerminalOn(api, target.cwd, position);
}

export function openSplitTerminalPanel(
	desktopId: string,
	target: PaneSplitTarget,
	position?: PanelPosition,
): Promise<void> {
	const api = getDockview(desktopId);
	return api ? openSplitTerminalOn(api, target, position) : Promise.resolve();
}
