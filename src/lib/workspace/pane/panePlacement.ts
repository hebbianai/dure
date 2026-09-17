import type { IDockviewPanel } from "dockview-react";

export interface PanePresentation {
	readonly panel: IDockviewPanel;
	readonly paneOwnership: "created_by_request" | "pre_existing";
}

/** dockview addPanel의 위치 옵션 (드롭 지점 지정용). floating이 있으면
 *  그리드 대신 떠 있는 그룹(shift+드래그 오버레이와 같은 형태)으로 연다 —
 *  드롭 위치가 마땅치 않을 때의 폴백(사용자 요청 2026-08-01). */
export type PanelPosition = {
	/** Ephemeral exact content handle; replacement keeps the pane's placement. */
	replacement?: IDockviewPanel["api"];
	referenceGroup?: unknown;
	referencePanel?: string;
	direction?: string;
	initialWidth?: number;
	floating?: { x: number; y: number; width?: number; height?: number };
};

/** addPanel 옵션으로 변환 — floating이면 기본 크기를 채워 오버레이로 연다. */
export function placementOptions(pos?: PanelPosition) {
	if (!pos) return {};
	if (pos.replacement) return { replacement: pos.replacement };
	if (pos.floating) {
		return {
			floating: { width: 560, height: 420, ...pos.floating },
		} as never;
	}
	const { initialWidth, ...position } = pos;
	return {
		...(initialWidth === undefined ? {} : { initialWidth }),
		position: position as never,
	};
}

/** dockview 드롭 위치(Position: left/right/top/bottom/center)를 addPanel의
 *  direction으로 변환 + 참조 그룹 지정. */
export function dropPosition(group: unknown, pos: string): PanelPosition {
	const dir =
		pos === "top"
			? "above"
			: pos === "bottom"
				? "below"
				: pos === "center"
					? "within"
					: pos;
	if (group) return { referenceGroup: group, direction: dir };
	return dir === "left" || dir === "right" || dir === "above" || dir === "below"
		? { direction: dir }
		: {};
}
