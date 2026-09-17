// 새 pane의 그리드식 배치 판정 — 순수 모듈.
//
// 규칙의 변천:
// - "활성 그룹 오른쪽 분할"뿐이면 옆으로만 길어져 좁은 세로 기둥들이 된다
//   (사용자 제보 2026-07-31).
// - "가장 큰 그룹을 긴 축으로" 분할하면 격자는 되지만 새 pane이 지금 보고
//   있는 곳과 무관한 자리에 튀어나와 예측이 안 된다(사용자 제보 2026-08-01).
// - 현행: **활성 그룹을 그 그룹의 긴 축으로** 분할한다(i3식 스파이럴).
//   새 pane은 항상 작업 중인 pane 옆에 생기고, 분할 축이 번갈아가며
//   자연스럽게 격자화된다. 반쪽이 최소 크기보다 작아질 때만 종전
//   최대-그룹 규칙으로 폴백해 슬리버를 막는다.
//
// 판정(pickAutoSplit/pickGridSplit)은 크기 배열만 받아 PTY/dockview 없이
// 테스트하고, dockview 표면을 읽는 autoSplitPosition만 api를 만진다.
import type { DockviewApi } from "dockview-react";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";

export interface PlacementCandidate {
	id: string;
	width: number;
	height: number;
}

export interface GridSplitChoice {
	referenceGroupId: string;
	direction: "right" | "below";
}

/** Ordinary terminals and agents form one predictable full-height right rail.
 * Match the post-add mean of visible Agent groups, counting a tabbed group once. */
export function rightRailPosition(api: DockviewApi): PanelPosition | undefined {
	if (api.panels.length === 0) return undefined;
	if (!Number.isFinite(api.width) || api.width <= 0) return { direction: "right" };
	const widths = new Map<string, number>();
	for (const panel of api.panels) {
		const { group } = panel;
		const width = group.api.width;
		if (
			panel.api.component === "agent" &&
			group.api.location.type === "grid" &&
			group.api.isVisible &&
			Number.isFinite(width) &&
			width > 0
		) {
			widths.set(group.id, width);
		}
	}
	if (widths.size === 0) return { direction: "right" };
	const meanWidth =
		[...widths.values()].reduce((sum, width) => sum + width, 0) / widths.size;
	// Existing widths scale by (W - x) / W, so a peer rail needs x = mean / (1 + mean / W).
	// Reusing the pre-add mean would request all available width for a second pane.
	return {
		direction: "right",
		initialWidth: Math.round(meanWidth / (1 + meanWidth / api.width)),
	};
}

/** 가장 큰 그룹을 긴 축으로 분할한다. 크기를 아직 모르면(0/음수 포함 —
 *  마운트 직후) undefined를 돌려 호출부가 기존 폴백(활성 그룹 오른쪽)을
 *  쓰게 한다. 폭/높이가 같은 정사각형은 가로 분할(right) — 터미널·에디터
 *  내용이 가로로 긴 매체라 세로 기둥보다 좌우 이웃이 먼저다. */
export function pickGridSplit(
	candidates: readonly PlacementCandidate[],
): GridSplitChoice | undefined {
	let best: PlacementCandidate | undefined;
	for (const candidate of candidates) {
		if (!(candidate.width > 0) || !(candidate.height > 0)) continue;
		if (
			!best ||
			candidate.width * candidate.height > best.width * best.height
		) {
			best = candidate;
		}
	}
	if (!best) return undefined;
	return {
		referenceGroupId: best.id,
		direction: best.width >= best.height ? "right" : "below",
	};
}

/** 분할 뒤 반쪽이 이보다 작아지면 활성 분할을 포기한다 — 터미널/에디터가
 *  실사용 불가능한 슬리버가 되는 것을 막는 하한. */
const MIN_HALF_WIDTH = 320;
const MIN_HALF_HEIGHT = 220;

/** 활성 그룹을 긴 축부터 시도해 분할하고, 두 축 모두 하한에 걸리거나 활성
 *  그룹을 모르면 가장 큰 그룹 규칙(pickGridSplit)으로 폴백한다. */
export function pickAutoSplit(
	candidates: readonly PlacementCandidate[],
	activeGroupId: string | undefined,
): GridSplitChoice | undefined {
	const active = candidates.find(
		(candidate) => candidate.id === activeGroupId,
	);
	if (active && active.width > 0 && active.height > 0) {
		const order: GridSplitChoice["direction"][] =
			active.width >= active.height ? ["right", "below"] : ["below", "right"];
		for (const direction of order) {
			const half =
				(direction === "right" ? active.width : active.height) / 2;
			const floor =
				direction === "right" ? MIN_HALF_WIDTH : MIN_HALF_HEIGHT;
			if (half >= floor) return { referenceGroupId: active.id, direction };
		}
	}
	return pickGridSplit(candidates);
}

/** 새 패널을 스택하지 않고 별도 그룹으로 분할하는 기본 위치. 첫 패널이면
 *  undefined(전체를 채움), 크기를 아직 모르면(테스트 더블·마운트 직후) 종전
 *  폴백(활성 그룹 오른쪽). floating/popout 그룹은 제외한다. "한 에이전트당 한
 *  패널" — 여러 패널이 한 그룹에 쌓여 탭바 숨김에 가려지는 문제를 막는 계약은
 *  그대로다. */
export function autoSplitPosition(
	api: DockviewApi,
): PanelPosition | undefined {
	if (api.panels.length === 0) return undefined;
	const activeGroup = api.activeGroup;
	const grid = pickAutoSplit(
		(api.groups ?? [])
			.filter((group) => group.api?.location?.type === "grid")
			.map((group) => ({
				id: group.id,
				width: group.api.width,
				height: group.api.height,
			})),
		activeGroup?.api?.location?.type === "grid" ? activeGroup.id : undefined,
	);
	if (!grid) return { direction: "right" };
	return { referenceGroup: grid.referenceGroupId, direction: grid.direction };
}
