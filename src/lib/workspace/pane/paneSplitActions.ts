// Generic split reserves a selector at the inherited execution location.
// Explicit Terminal and SSH choices still open their chosen shell directly.

import { track } from "@/lib/ipc/telemetry";
import { readRecentSshHostId } from "@/lib/ssh/recentSshHost";
import {
	openSplitLauncherPanel,
	openSplitTerminalPanel,
	paneSplitTargetForPanel,
} from "@/lib/workspace/pane/paneSplit";
import type { PaneSplitPaneParams } from "@/lib/workspace/pane/paneSplitTarget";
import type { SshHostConfig } from "@/types";

type PaneSplitDirection = "right" | "below";

/** 분할 메뉴가 통째로 받는 값 — 세 동작과 그 라벨은 같은 결정의 부분들이라
 *  호출부에서 흩어지지 않게 한 객체로 나간다. */
export interface PaneSplitActions {
	/** Reserve a selector inheriting this pane's current execution location. */
	splitPane: (direction: PaneSplitDirection) => void;
	/** 이 pane이 원격이든 아니든 로컬 셸을 연다. */
	splitTerminalPane: (direction: PaneSplitDirection) => void;
	splitSshPane: (direction: PaneSplitDirection, host: SshHostConfig) => void;
	/** "최근" 표시가 붙을 호스트 — 마지막으로 실제 접속에 성공한 하나. */
	recentSshHostId: string | undefined;
}

export function paneSplitActions({
	desktopId,
	panelId,
	component,
	params,
}: {
	desktopId: string | undefined;
	panelId: string;
	component: string;
	params?: PaneSplitPaneParams;
}): PaneSplitActions {
	const open = (
		direction: PaneSplitDirection,
		target: Parameters<typeof openSplitTerminalPanel>[1],
	) => {
		if (!desktopId) return;
		track("pane_split", { direction });
		openSplitTerminalPanel(desktopId, target, {
			referencePanel: panelId,
			direction,
		});
	};
	return {
		splitPane: (direction) => {
			if (!desktopId) return;
			track("pane_split", { direction });
			openSplitLauncherPanel(
				desktopId,
				paneSplitTargetForPanel({ id: panelId, component }, params),
				{
					referencePanel: panelId,
					direction,
				},
			);
		},
		splitTerminalPane: (direction) => open(direction, { kind: "local" }),
		splitSshPane: (direction, host) =>
			open(direction, { kind: "ssh", hostId: host.id }),
		recentSshHostId: readRecentSshHostId(),
	};
}
