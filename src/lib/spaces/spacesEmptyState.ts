/**
 * 빈 스페이스 목록이 어떤 빈 상태인지 판정 (hebbian-frontend-vfse).
 *
 * "열린 세션이 없습니다"는 세 가지 서로 다른 상황을 한 문장으로 덮고 있었고,
 * 각각 다음 행동이 다르다:
 *
 * - no_match: 검색어 때문에 안 보인다. 다음 행동은 검색 지우기 — 스페이스를
 *   더 만드는 게 아니다.
 * - no_locations: 아직 폴더(위치)를 하나도 안 넣었다. 첫 사용자가 여기 선다.
 *   pane 추가 메뉴를 눌러도 열 위치가 없으므로 위치 추가가 유일한 다음 행동.
 * - no_sessions: 위치는 있고 열린 세션만 없다. 추가 메뉴가 실제로 동작한다.
 *
 * 판정을 순수 함수로 분리한 이유: 세 분기의 우선순위(검색이 위치 부재를
 * 가린다)가 렌더 조건에 섞이면 "첫 사용자에게 검색 지우기를 권하는" 조합이
 * 조용히 생긴다.
 */
export type SpacesEmptyStateKind = "no_match" | "no_locations" | "no_sessions";

export function spacesEmptyStateKind(input: {
	/** 정규화된 검색어 (trim + lowercase). */
	query: string;
	/** A non-default facet selection can narrow the list without search text. */
	filtersActive?: boolean;
	/** 스페이스를 열 수 있는 위치가 하나라도 있는지. */
	hasLocations: boolean;
}): SpacesEmptyStateKind {
	// Active search or filters own the empty cause regardless of locations:
	// adding a folder cannot widen the current row projection.
	if (input.query.length > 0 || input.filtersActive) return "no_match";
	return input.hasLocations ? "no_sessions" : "no_locations";
}
