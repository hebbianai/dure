// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpacesEmptyState } from "@/components/spaces/SpacesEmptyState";
import { t } from "@/lib/i18n";

afterEach(cleanup);

describe("SpacesEmptyState", () => {
	// 첫 사용자: 열 위치가 없으면 pane 추가 메뉴는 아무것도 못 연다. CTA가
	// 위치 추가로 변신해야 한다 (Emdash의 구성 적응형 CTA).
	it("위치가 없으면 폴더 추가가 유일한 다음 행동이다", () => {
		const onAddFolder = vi.fn();
		render(
			<SpacesEmptyState
				query=""
				kind="no_locations"
				onClearQuery={vi.fn()}
				onAddFolder={onAddFolder}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /폴더 추가하기/ }));
		expect(onAddFolder).toHaveBeenCalledOnce();
		expect(screen.queryByText(/\+ 버튼으로/)).toBeNull();
	});

	it("위치가 있고 세션만 없으면 추가 메뉴를 가리킨다", () => {
		render(
			<SpacesEmptyState
				query=""
				kind="no_sessions"
				onClearQuery={vi.fn()}
				onAddFolder={vi.fn()}
			/>,
		);
		expect(screen.getByText(/열린 세션이 없습니다/)).toBeTruthy();
		expect(screen.getByText(/\+ 버튼으로/)).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	// 검색 무결과에 "폴더 추가"를 권하면 오답이다 — 검색어를 지우기 전에는
	// 폴더를 추가해도 목록이 그대로 비어 보인다.
	it("검색 무결과는 검색 지우기만 제안한다", () => {
		const onClearQuery = vi.fn();
		render(
			<SpacesEmptyState
				query="zzz"
				kind="no_match"
				onClearQuery={onClearQuery}
				onAddFolder={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /검색 지우기/ }));
		expect(onClearQuery).toHaveBeenCalledOnce();
		expect(screen.queryByText(/폴더 추가하기/)).toBeNull();
	});

	it("스크린리더가 빈 상태 변화를 알 수 있게 status로 알린다", () => {
		render(
			<SpacesEmptyState
				query=""
				kind="no_sessions"
				onClearQuery={vi.fn()}
				onAddFolder={vi.fn()}
			/>,
		);
		expect(screen.getByRole("status")).toBeTruthy();
	});

	it("offers a filter reset when facets hide every row", () => {
		const onResetFilters = vi.fn();
		render(
			<SpacesEmptyState
				query=""
				filtersActive
				kind="no_match"
				onClearQuery={vi.fn()}
				onResetFilters={onResetFilters}
				onAddFolder={vi.fn()}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: t("spaces.pane.resetFilters") }),
		);
		expect(onResetFilters).toHaveBeenCalledOnce();
	});
});
