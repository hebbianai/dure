/**
 * 좌측 목록 패널 폭 드래그 조절의 순수 부분.
 *
 * 사이드바(Sidebar.tsx)는 "더 끌면 접힌다"는 자기 히스테리시스가 있어 별개
 * 로직을 갖는다. 여기는 접히지 않는 패널용 — 클램프만 필요하다. DOM 배선은
 * 호출자가 하고, 경계 계산은 테스트 가능한 이 함수가 갖는다.
 */

export interface PanelWidthBounds {
	min: number;
	max: number;
}

/**
 * 드래그 좌표를 패널 폭으로 클램프한다.
 *
 * max는 창 폭에서 오는 값이라 min보다 작아질 수 있다(창을 아주 좁게 만든
 * 경우). 그때 max를 그대로 쓰면 패널이 내용도 못 담을 만큼 줄어드니 min을
 * 우선한다 — 좁은 창에서 목록이 사라지는 것보다 넘치는 게 낫다.
 */
export function clampPanelWidth(px: number, bounds: PanelWidthBounds): number {
	if (!Number.isFinite(px)) return bounds.min;
	const max = Math.max(bounds.min, bounds.max);
	return Math.round(Math.min(max, Math.max(bounds.min, px)));
}

/** 창 폭 대비 패널이 차지할 수 있는 상한. 나머지가 diff 본문이므로 절반을
 *  넘기지 않는다 — 목록이 본문보다 넓은 배치는 이 창의 용도가 아니다. */
export function panelWidthCeiling(windowWidth: number): number {
	return Math.max(0, Math.floor(windowWidth / 2));
}
