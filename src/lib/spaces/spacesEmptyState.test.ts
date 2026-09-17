import { describe, expect, it } from "vitest";
import { spacesEmptyStateKind } from "@/lib/spaces/spacesEmptyState";

describe("spacesEmptyStateKind", () => {
	it("위치가 없으면 첫 사용자 상태다", () => {
		expect(spacesEmptyStateKind({ query: "", hasLocations: false })).toBe(
			"no_locations",
		);
	});

	it("위치가 있고 세션만 없으면 세션 없음 상태다", () => {
		expect(spacesEmptyStateKind({ query: "", hasLocations: true })).toBe(
			"no_sessions",
		);
	});

	it("검색 중이면 검색 무결과다", () => {
		expect(spacesEmptyStateKind({ query: "abc", hasLocations: true })).toBe(
			"no_match",
		);
	});

	// 검색이 위치 부재를 가린다 — 검색어를 지우기 전에는 위치를 추가해도 목록이
	// 여전히 비어 보이므로, 위치 추가를 권하면 오답이다.
	it("검색 중이면 위치가 없어도 검색 무결과가 우선한다", () => {
		expect(spacesEmptyStateKind({ query: "abc", hasLocations: false })).toBe(
			"no_match",
		);
	});

	it("treats active facet filters as the no-match cause", () => {
		expect(
			spacesEmptyStateKind({
				query: "",
				hasLocations: true,
				filtersActive: true,
			}),
		).toBe("no_match");
	});
});
