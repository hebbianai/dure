// @vitest-environment jsdom
// 이 페이지에서 가장 중요한 계약: 아무것도 제어하지 않는 컨트롤을 두지 않는다.
// 시안(2525:74656)은 텔레메트리 스위치를 그리지만 이 저장소에는 그 설정이
// 없어서, 스위치를 두면 끄고 나서 "이제 안 보낸다"고 믿게 되는 거짓 보증이 된다.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { PrivacyPage } from "@/components/settings/PrivacyPage";

afterEach(cleanup);

describe("PrivacyPage", () => {
	it("배선되지 않은 스위치나 버튼을 두지 않는다", () => {
		const { container } = render(<PrivacyPage />);
		expect(container.querySelector('[role="switch"]')).toBeNull();
		expect(container.querySelector("button")).toBeNull();
		expect(container.querySelector("input")).toBeNull();
	});

	it("컨트롤 자리에 지금 상태를 말하는 알약을 둔다", () => {
		render(<PrivacyPage />);
		expect(screen.getByText("수집 안 함")).toBeTruthy();
		// 이 대화상자는 이제 보내기도 한다 — "직접 저장"은 더 이상 이 행이
		// 말하는 것을 설명하지 못한다.
		expect(screen.getByText("직접 고를 때만")).toBeTruthy();
		expect(screen.getByText("이 기기에만")).toBeTruthy();
		expect(screen.getByText("보낼 때만")).toBeTruthy();
	});

	it("네 항목을 hairline으로 나눈다", () => {
		const { container } = render(<PrivacyPage />);
		expect(container.querySelectorAll("section").length).toBe(4);
		expect(container.querySelectorAll("section.border-t").length).toBe(3);
	});

	// 스위치가 없는 이유를 본문이 직접 말해야 한다 — 컨트롤의 부재가 곧 답이다.
	it("스위치가 없는 이유를 설명한다", () => {
		render(<PrivacyPage />);
		expect(
			screen.getByText(/끌 스위치가 없는 것은 켜져 있는 것이 없기 때문입니다/),
		).toBeTruthy();
	});
});
