import type { DockviewApi } from "dockview-react";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import {
	clearFilePaneHidden,
	useHiddenFilePanes,
} from "@/lib/workspace/pane/hiddenFilePanesStore";
import {
	clearPaneHiddenAfterRestore,
	markPaneHidden,
	useHiddenPanes,
} from "@/lib/workspace/pane/hiddenPanesStore";

/** pane을 그리드에서 제거하지 않고 해당 group의 슬롯만 숨긴다. Dockview가
 *  원래 크기와 중첩 위치를 보관하므로 다시 보일 때 같은 자리를 되찾는다. */
export function hidePanePreservingLayout(
	api: Pick<DockviewApi, "getPanel">,
	panelId: string,
): boolean {
	const panel = api.getPanel(panelId);
	// group visibility는 group 전체에 적용된다. 구 레이아웃의 stacked group이면
	// 다른 탭까지 숨기지 말고 호출부의 기존 panel 제거 폴백을 사용한다.
	if (panel?.group.panels.length !== 1) return false;
	// floating group은 hidden이 직렬화에서 크기 0·visible로 깨진다(실측
	// 2026-08-01, 데스크탑 전환 한 번에 2×2px 점으로 재등장). 호출부의 제거
	// 폴백 + anchor rect 재생성 경로를 쓴다.
	if (panel.group.api.location.type !== "grid") return false;
	panel.group.api.setVisible(false);
	return true;
}

/** 숨겨 둔 group을 원래 슬롯에서 다시 보이고 그 pane을 활성화한다. */
export function restorePanePreservingLayout(
	api: Pick<DockviewApi, "getPanel">,
	panelId: string,
): boolean {
	const panel = api.getPanel(panelId);
	if (!panel) return false;
	if (!panel.group.api.isVisible) {
		panel.group.api.setVisible(true);
		// DOM boundingBox는 복원 직후 임시 최소 크기(100x100)일 수 있다.
		// Dockview 모델이 보유한 현재 크기를 다시 요청해 부모 resizeView 경로가
		// viewport를 넘친 sibling 공간을 재분배하게 한다. 이미 보이는 pane의
		// 일반 포커스에는 이 resize를 반복하지 않는다.
		const { width, height } = panel.group.api;
		if (width > 0 && height > 0) {
			panel.group.api.setSize({ width, height });
		}
	}
	panel.api.setActive();
	if (panel.api.component === "agent") {
		const ref = dockPanelReference(panel);
		const agentId = agentIdFromPaneParameters(ref.params);
		if (agentId && useHiddenPanes.getState().hidden[agentId]) {
			clearPaneHiddenAfterRestore(agentId);
		}
	}
	if (
		panel.api.component === "fileviewer" &&
		useHiddenFilePanes.getState().hidden[panelId]
	) {
		clearFilePaneHidden(panelId);
	}
	return true;
}

/** Dockview에는 숨긴 panel도 계속 등록되어 있으므로 Spaces의 열린 목록에서는
 *  숨김 기록이 있는 agent를 제외하고 전용 hidden 행으로 다시 합쳐야 한다. */
export function excludeHiddenAgentPanes<T extends { readonly agentId?: string }>(
	spaces: readonly T[],
	hidden: Readonly<Record<string, unknown>>,
): T[] {
	return spaces.filter(
		(space) => !space.agentId || !(space.agentId in hidden),
	);
}

/** Project hidden records from the committed target content, synchronously with
 * the layout move. Unchanged targets need not appear in receipt.updates.
 * A later draft acknowledgement must not rewrite newer hides. */
export function retargetMovedHiddenPanes<
	T extends {
		readonly movedPanelIds: readonly string[];
		readonly updates: Readonly<Record<string, unknown>>;
	},
>(receipt: T, targetDesktopId: string, targetLayout: unknown): T {
	const hidden = useHiddenPanes.getState().hidden;
	const hiddenFiles = useHiddenFilePanes.getState().hidden;
	const moved = new Set(receipt.movedPanelIds);
	const sourceDesktopIds = new Set(Object.keys(receipt.updates));
	sourceDesktopIds.delete(targetDesktopId);
	for (const panel of panelsFromLayout(targetLayout)) {
		if (!moved.has(panel.id)) continue;
		if (panel.component === "agent") {
			const agentId = agentIdFromPaneParameters(panel.params);
			const record = agentId ? hidden[agentId] : undefined;
			if (agentId && record && sourceDesktopIds.has(record.desktopId)) {
				markPaneHidden(agentId, targetDesktopId, panel.id);
			}
		}
		const fileRecord = hiddenFiles[panel.id];
		if (
			panel.component === "fileviewer" &&
			fileRecord &&
			sourceDesktopIds.has(fileRecord.desktopId)
		) {
			useHiddenFilePanes.getState().markHidden(panel.id, {
				desktopId: targetDesktopId,
				file: fileRecord.file,
				...(fileRecord.anchor ? { anchor: fileRecord.anchor } : {}),
			});
		}
	}
	return receipt;
}
