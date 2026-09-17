// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDesignModePicker } from "@/lib/design/designModePicker";

const overlay = () => document.getElementById("dure-design-mode-overlay");
const shadowQuery = (selector: string) =>
	overlay()?.shadowRoot?.querySelector(selector) as HTMLElement | undefined;

/** jsdom에는 레이아웃이 없어 elementFromPoint가 항상 null이다 — 무엇이 커서
 *  아래 있는지를 테스트가 정한다. */
function pointAt(element: Element | null) {
	document.elementFromPoint = () => element as Element;
}

/** 이벤트는 window 캡처 단계에서 관찰된다 — 페이지에서 일어난 것처럼 보낸다. */
const move = (x: number, y: number) =>
	window.dispatchEvent(
		new PointerEvent("pointermove", { clientX: x, clientY: y }),
	);
const rightClick = (x: number, y: number) =>
	window.dispatchEvent(
		new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			clientX: x,
			clientY: y,
		}),
	);
const menuItem = (text: string) => {
	const items = overlay()?.shadowRoot?.querySelectorAll(".item") ?? [];
	return [...items].find((item) => item.textContent === text) as
		| HTMLElement
		| undefined;
};

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("startDesignModePicker", () => {
	it("오버레이를 shadow root 안에 만든다 — 대상 페이지 스타일과 섞이지 않게", () => {
		const handle = startDesignModePicker({ onPick: vi.fn() });
		expect(overlay()).toBeTruthy();
		expect(overlay()?.shadowRoot).toBeTruthy();
		// 페이지 DOM에는 오버레이 내부가 노출되지 않는다.
		expect(document.querySelector(".box")).toBeNull();
		handle.stop();
	});

	// 사용자 결정(2026-07-31): 픽 모드에서도 앱은 평소처럼 조작돼야 한다.
	it("일반 클릭은 캡처하지 않는다 — 앱으로 그대로 흘러간다", () => {
		document.body.innerHTML = `<main><button class="save">Save</button></main>`;
		pointAt(document.querySelector("button"));
		const onPick = vi.fn();
		const handle = startDesignModePicker({ onPick });
		move(5, 5);

		const click = new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
			clientX: 5,
			clientY: 5,
		});
		window.dispatchEvent(click);

		expect(onPick).not.toHaveBeenCalled();
		expect(click.defaultPrevented).toBe(false);
		// 모드도 유지된다 — 클릭 한 번에 렌즈가 꺼지면 열어 둔 채 쓸 수 없다.
		expect(overlay()).toBeTruthy();
		handle.stop();
	});

	it("우클릭 메뉴에서 '프롬프트에 입력'을 고르면 send 캡처를 넘긴다", () => {
		document.body.innerHTML = `<main><button class="save">Save</button></main>`;
		const button = document.querySelector("button") as Element;
		pointAt(button);
		const onPick = vi.fn();
		startDesignModePicker({ onPick });
		move(5, 5);
		rightClick(5, 5);

		menuItem("Type into agent prompt")?.click();

		expect(onPick).toHaveBeenCalledOnce();
		const [captured, element, intent] = onPick.mock.calls[0];
		expect(captured.label).toBe("button.save");
		expect(captured.html).toContain("Save");
		expect(element).toBe(button);
		expect(intent).toBe("send");
		// 한 번 집으면 끝나는 계약 — 오버레이도 함께 사라진다.
		expect(overlay()).toBeNull();
	});

	it("우클릭 메뉴의 '복사'는 copy intent로 넘긴다", () => {
		document.body.innerHTML = `<main><button class="save">Save</button></main>`;
		pointAt(document.querySelector("button"));
		const onPick = vi.fn();
		startDesignModePicker({ onPick });
		move(5, 5);
		rightClick(5, 5);

		menuItem("Copy to clipboard")?.click();

		expect(onPick.mock.calls[0][2]).toBe("copy");
	});

	it("우클릭이 브라우저 기본 메뉴를 막고 액션 메뉴를 띄운다", () => {
		document.body.innerHTML = `<main><button class="save">Save</button></main>`;
		pointAt(document.querySelector("button"));
		const handle = startDesignModePicker({ onPick: vi.fn() });
		move(5, 5);

		const event = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			clientX: 5,
			clientY: 5,
		});
		window.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(shadowQuery(".menu")).toBeTruthy();
		handle.stop();
	});

	// 터미널·에디터 내부는 렌더 결과라 집을 의미가 없다(designModeCapture 규칙).
	it("집을 수 없는 영역의 우클릭은 가로채지 않는다", () => {
		document.body.innerHTML = `<div class="xterm-screen"><span>$</span></div>`;
		pointAt(document.querySelector("span"));
		const onPick = vi.fn();
		const handle = startDesignModePicker({ onPick });
		move(5, 5);

		const event = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			clientX: 5,
			clientY: 5,
		});
		window.dispatchEvent(event);

		expect(onPick).not.toHaveBeenCalled();
		// 브라우저 기본 메뉴가 그대로 나온다 — 픽커는 켜진 채 남는다.
		expect(event.defaultPrevented).toBe(false);
		expect(shadowQuery(".menu")).toBeFalsy();
		expect(overlay()).toBeTruthy();
		handle.stop();
	});

	it("메뉴가 떠 있을 때 Esc는 메뉴만 닫는다 — 모드는 유지", () => {
		document.body.innerHTML = `<main><button class="save">Save</button></main>`;
		pointAt(document.querySelector("button"));
		const onCancel = vi.fn();
		const handle = startDesignModePicker({ onPick: vi.fn(), onCancel });
		move(5, 5);
		rightClick(5, 5);
		expect(shadowQuery(".menu")).toBeTruthy();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(shadowQuery(".menu")).toBeFalsy();
		expect(onCancel).not.toHaveBeenCalled();
		expect(overlay()).toBeTruthy();

		// 메뉴가 없는 상태의 Esc가 모드를 끝낸다.
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(onCancel).toHaveBeenCalledOnce();
		expect(overlay()).toBeNull();
		handle.stop();
	});

	it("메뉴의 'Exit Pinpoint'는 모드를 끝낸다", () => {
		document.body.innerHTML = `<main><button class="save">Save</button></main>`;
		pointAt(document.querySelector("button"));
		const onCancel = vi.fn();
		startDesignModePicker({ onPick: vi.fn(), onCancel });
		move(5, 5);
		rightClick(5, 5);

		menuItem("Exit Pinpoint")?.click();

		expect(onCancel).toHaveBeenCalledOnce();
		expect(overlay()).toBeNull();
	});

	it("Esc로 취소하면 오버레이가 사라지고 취소를 알린다", () => {
		const onCancel = vi.fn();
		startDesignModePicker({ onPick: vi.fn(), onCancel });
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(onCancel).toHaveBeenCalledOnce();
		expect(overlay()).toBeNull();
	});

	it("stop()은 여러 번 불러도 안전하다", () => {
		const handle = startDesignModePicker({ onPick: vi.fn() });
		handle.stop();
		handle.stop();
		expect(overlay()).toBeNull();
	});

	// 픽커가 꺼진 뒤에도 Esc 핸들러가 남아 있으면 앱의 Esc(다이얼로그 닫기 등)를
	// 조용히 삼킨다.
	it("끈 뒤에는 Esc를 더 이상 잡지 않는다", () => {
		const onCancel = vi.fn();
		const handle = startDesignModePicker({ onPick: vi.fn(), onCancel });
		handle.stop();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("커서 아래에 집을 것이 없으면 하이라이트를 숨긴다", () => {
		pointAt(null);
		const handle = startDesignModePicker({ onPick: vi.fn() });
		move(1, 1);
		const box = shadowQuery(".box");
		expect(box?.style.display).toBe("none");
		handle.stop();
	});
});

describe("픽커 대상 조정", () => {
	const pickVia = (onPick: ReturnType<typeof vi.fn>, x: number, y: number) => {
		rightClick(x, y);
		menuItem("Type into agent prompt")?.click();
		return onPick.mock.calls[0]?.[0];
	};

	it("ArrowUp이 조상으로 넓히고 ArrowDown이 되돌린다", () => {
		document.body.innerHTML = `<main><button class="save"><span class="t">Save</span></button></main>`;
		pointAt(document.querySelector("span"));
		const onPick = vi.fn();
		startDesignModePicker({ onPick });
		move(5, 5);

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
		expect(pickVia(onPick, 5, 5)?.label).toBe("button.save");
	});

	// 실측: 클릭 직전의 1px 흔들림에 넓힌 선택이 풀렸다(Playwright의 click이 move를
	// 먼저 보낸다. 실제 마우스도 같다). 같은 요소 위 움직임은 유지해야 한다.
	it("같은 요소 위에서 움직이면 넓힌 깊이를 유지한다", () => {
		document.body.innerHTML = `<main><button class="save"><span class="t">Save</span></button></main>`;
		pointAt(document.querySelector("span"));
		const onPick = vi.fn();
		startDesignModePicker({ onPick });
		move(5, 5);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
		move(6, 6);
		expect(pickVia(onPick, 6, 6)?.label).toBe("button.save");
	});

	it("다른 요소로 넘어가면 넓힌 깊이가 초기화된다", () => {
		document.body.innerHTML = `<main><button class="save"><span class="t">Save</span></button></main><aside class="other">x</aside>`;
		pointAt(document.querySelector("span"));
		const onPick = vi.fn();
		startDesignModePicker({ onPick });
		move(5, 5);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
		pointAt(document.querySelector(".other"));
		move(90, 90);
		expect(pickVia(onPick, 90, 90)?.label).toBe("aside.other");
	});

	it("body 위로는 넓히지 않는다", () => {
		document.body.innerHTML = `<div class="only">x</div>`;
		pointAt(document.querySelector(".only"));
		const onPick = vi.fn();
		startDesignModePicker({ onPick });
		move(5, 5);
		for (let i = 0; i < 5; i += 1) {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
		}
		expect(pickVia(onPick, 5, 5)?.label).toBe("div.only");
	});
});
