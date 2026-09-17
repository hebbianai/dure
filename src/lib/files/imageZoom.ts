// 이미지 뷰어 줌 판정 — 순수 모듈. VS Code 이미지 프리뷰 관례를 따른다:
// ⌘/Ctrl+휠(트랙패드 핀치 포함)로 줌, 일반 휠은 팬(네이티브 스크롤),
// 더블클릭은 맞춤↔100% 토글, 버튼은 이산 스텝.

export const MIN_ZOOM = 0.125;
export const MAX_ZOOM = 8;

export function clampZoom(scale: number): number {
	if (!Number.isFinite(scale)) return 1;
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** 버튼 한 번 = ×1.25 (축소는 역수). 반복해도 왕복 오차가 쌓이지 않게
 *  라운딩은 표시에서만 한다. */
export function stepZoom(scale: number, direction: 1 | -1): number {
	return clampZoom(direction > 0 ? scale * 1.25 : scale / 1.25);
}

/** 휠/핀치 → 지수 스케일. deltaY 400당 e배 — 트랙패드의 연속 델타와
 *  마우스 휠의 큰 델타 양쪽에서 자연스러운 속도다. */
export function wheelZoom(scale: number, deltaY: number): number {
	return clampZoom(scale * Math.exp(-deltaY / 400));
}

/** 컨테이너에 맞는 배율. 원본이 더 작으면 확대하지 않는다(1 상한) —
 *  아이콘류가 흐릿하게 늘어나는 것보다 실제 크기가 정직하다. */
export function fitScale(
	naturalWidth: number,
	naturalHeight: number,
	viewWidth: number,
	viewHeight: number,
): number {
	if (
		!(naturalWidth > 0) ||
		!(naturalHeight > 0) ||
		!(viewWidth > 0) ||
		!(viewHeight > 0)
	) {
		return 1;
	}
	return Math.min(viewWidth / naturalWidth, viewHeight / naturalHeight, 1);
}
