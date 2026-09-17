// @vitest-environment jsdom
// 시안 2527:84810 레이아웃 잠금 — 페이지를 감싸던 720px 카드를 걷고, 상태 필터는
// 설정 사이드바와 같은 목록 어휘를 쓰며, 스코프 칩은 명령 이름 옆에 붙는다.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ShortcutsPage } from "@/components/settings/ShortcutsPage";
import { setLang } from "@/lib/i18n";
import { useStore } from "@/store";

afterEach(() => {
	cleanup();
	setLang("ko");
	useStore.setState({ shortcutOverrides: {} });
});

describe("ShortcutsPage", () => {
	it("페이지를 감싸던 카드를 더 이상 그리지 않는다", () => {
		const { container } = render(<ShortcutsPage />);
		expect(container.querySelector(".max-w-\\[720px\\]")).toBeNull();
		// 그룹은 hairline으로 갈린다.
		expect(container.querySelectorAll("section.border-t").length).toBeGreaterThan(0);
		expect(screen.getByText("터미널 · 표시")).toBeTruthy();
	});

	it("언어 리마운트에서 현재 카탈로그로 그룹 이름을 다시 해석한다", () => {
		const view = render(<ShortcutsPage />);
		expect(screen.getByText("터미널 · 표시")).toBeTruthy();
		expect(screen.getByText("터미널 글자 크게")).toBeTruthy();
		view.unmount();

		setLang("en");
		render(<ShortcutsPage />);
		expect(screen.getByText("Terminal · Display")).toBeTruthy();
		expect(screen.getByText("Increase terminal font")).toBeTruthy();
		fireEvent.change(screen.getByPlaceholderText("Search command or key"), {
			target: { value: "Native" },
		});
		expect(screen.getByText("Native Search")).toBeTruthy();
		expect(screen.queryByText("Open Settings")).toBeNull();
	});

	it("상태 필터가 설정 사이드바와 같은 목록 어휘를 쓴다", () => {
		render(<ShortcutsPage />);
		for (const label of ["All", "Modified", "Unassigned", "Conflicts"]) {
			const button = screen.getByRole("button", { name: new RegExp(`^${label}`) });
			expect(button.className).toContain("h-8");
			expect(button.className).toContain("rounded-md");
		}
	});

	it("상태 필터가 실제로 목록을 거른다", () => {
		render(<ShortcutsPage />);
		// 기본 상태에서는 재지정된 항목이 없다.
		fireEvent.click(screen.getByRole("button", { name: /^Modified/ }));
		expect(screen.getByText("일치하는 단축키가 없습니다")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /^All/ }));
		expect(screen.queryByText("일치하는 단축키가 없습니다")).toBeNull();
	});

	// 키캡이 명령 길이를 따라 움직이면 "어떤 키였더라"를 훑기 어려워진다.
	it("스코프 칩은 명령 이름과 한 덩어리로 왼쪽에 붙는다", () => {
		render(<ShortcutsPage />);
		const command = screen.getByText("통합 검색");
		const group = command.parentElement;
		expect(group).toBeTruthy();
		expect(within(group as HTMLElement).getByText("Dure")).toBeTruthy();
		expect((group as HTMLElement).className).toContain("flex-1");
	});

	it("검색이 명령 이름으로 목록을 좁힌다", () => {
		render(<ShortcutsPage />);
		fireEvent.change(screen.getByPlaceholderText("명령 또는 키 검색"), {
			target: { value: "통합" },
		});
		expect(screen.getByText("통합 검색")).toBeTruthy();
		expect(screen.queryByText("설정 열기")).toBeNull();
	});
});
