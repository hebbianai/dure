// Pinpoint 진입 목록 — 순수 판정.
//
// 왜 목록을 데이터로 두나: 두 진입(우리 UI / 내 앱)의 가용 조건이 다르다.
// 우리 UI를 짚는 것은 dev 빌드에서만 뜻이 있고(소스 위치 data-dure-src가 dev
// 빌드에만 심긴다), 내 앱을 여는 것은 모든 사용자용이다. 이 차이를 버튼
// 컴포넌트 안에 if로 흩어 두면 "프로덕션에서 뭐가 보이나"를 실행해 봐야만
// 알 수 있다. 목록으로 두면 테스트가 답한다.

import { t } from "@/lib/i18n";

export type PinpointActionId = "self" | "browser";

export interface PinpointAction {
	id: PinpointActionId;
	/** Display-ready label — resolved through t() at call time; passing it
	 *  through t() again is a harmless lookup miss. */
	label: string;
	/** 표시용 키캡. 카탈로그(settingsShortcuts)와 같은 값을 쓴다. */
	shortcut: string;
}

/** 이 빌드에서 실제로 쓸 수 있는 진입들. 순서는 표시 순서다. */
export function pinpointActions(dev: boolean): PinpointAction[] {
	const self: PinpointAction = {
		id: "self",
		label: t("design.pinpoint.commandLabel"),
		shortcut: "⌥⇧D",
	};
	const browser: PinpointAction = {
		id: "browser",
		label: t("design.pinpoint.openMyApp"),
		shortcut: "⌥⇧B",
	};
	return dev ? [self, browser] : [browser];
}

/** 진입이 하나뿐이면 메뉴를 열 이유가 없다 — 버튼이 곧 그 동작이다.
 *  (프로덕션에서 항목 하나짜리 드롭다운은 클릭을 한 번 더 받을 뿐이다.) */
export function pinpointIsDirect(dev: boolean): boolean {
	return pinpointActions(dev).length === 1;
}
