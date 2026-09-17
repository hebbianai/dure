import { describe, expect, it } from "vitest";
import { pinpointActions, pinpointIsDirect } from "@/lib/design/pinpointActions";

describe("pinpointActions", () => {
	it("dev 빌드는 두 진입을 모두 낸다", () => {
		expect(pinpointActions(true).map((action) => action.id)).toEqual([
			"self",
			"browser",
		]);
	});

	it("프로덕션은 '내 앱 열기'만 낸다", () => {
		// 우리 UI를 짚는 것은 소스 위치(data-dure-src)가 있는 dev 빌드에서만
		// 뜻이 있다. 프로덕션에서 그 항목을 보여 주면 눌러도 아무 일이 없다.
		expect(pinpointActions(false).map((action) => action.id)).toEqual([
			"browser",
		]);
	});

	it("모든 진입에 라벨과 키캡이 있다", () => {
		for (const action of pinpointActions(true)) {
			expect(action.label.length).toBeGreaterThan(0);
			expect(action.shortcut).toMatch(/^⌥⇧[A-Z]$/);
		}
	});

	it("진입이 하나뿐이면 메뉴 없이 바로 실행한다", () => {
		expect(pinpointIsDirect(false)).toBe(true);
		expect(pinpointIsDirect(true)).toBe(false);
	});
});
