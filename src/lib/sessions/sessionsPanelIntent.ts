// Spaces → 세션 패널 이동 인계 (2026-08-01 승격 리뷰 발견 #9).
//
// "전체 보기"는 검색 컨텍스트를 갖고 있다 — Spaces에서 'foo'로 좁힌 최근
// 목록의 전체 보기를 눌렀는데 빈 검색의 패널 맨 위에 떨어지면 사용자는
// 검색을 다시 입력해야 한다. 탭 전환은 컴포넌트 경계를 넘으므로(콜백 불가)
// 1회성 인계 슬롯으로 전달한다. 패널이 mount 시 가져가고 즉시 비운다 —
// 다음 일반 진입에 이전 검색이 되살아나면 안 된다.

let pendingSearch: string | null = null;

export function setPendingSessionsPanelSearch(query: string): void {
	pendingSearch = query;
}

/** 대기 중인 인계 검색어를 가져가며 비운다. 없으면 빈 문자열. */
export function takePendingSessionsPanelSearch(): string {
	const value = pendingSearch ?? "";
	pendingSearch = null;
	return value;
}
