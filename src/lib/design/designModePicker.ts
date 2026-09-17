/**
 * Design Mode 픽커 — hover 하이라이트 + 우클릭 액션 메뉴 (앱 런타임 비의존).
 *
 * 상호작용 규칙(사용자 결정 2026-07-31): 픽 모드에서도 **일반 클릭은 앱에 그대로
 * 전달**된다 — 오버레이는 pointer-events:none으로 페이지를 막지 않고, 캡처는
 * **우클릭 메뉴**에서 명시적으로 고른다. 처음엔 좌클릭 캡처의 모달 방식이었는데,
 * 그러면 집는 동안 앱을 조작할 수 없어 "열어 둔 채 쓰는 렌즈"가 못 됐다.
 *
 * designModeCapture와 같은 규칙으로 **다른 모듈을 import 하지 않는다.** B단계에서
 * 사용자 앱 창에 주입할 때 그대로 쓰려면 React·store·i18n에 기대면 안 된다.
 * (Menu copy is literal English — the injection context has no i18n, and
 * English is the product's fallback language.)
 * 오버레이는 shadow root 안에 산다 — 대상 페이지(우리 앱이든 사용자 앱이든)의
 * 스타일과 섞이면 그 앱의 버그로 오인된다.
 */
import {
	type CapturedElement,
	captureElement,
	isPickableTarget,
	normalizePickTarget,
} from "@/lib/design/designModeCapture";

/** 우클릭 메뉴에서 고른 동작. send = 카드로 이어 에이전트 전달, copy = 즉시 복사. */
type PickIntent = "send" | "copy";

export interface PickerHandle {
	/** 픽커를 끈다. 여러 번 불러도 안전하다. */
	stop: () => void;
}

export interface PickerCallbacks {
	onPick: (
		captured: CapturedElement,
		element: Element,
		intent: PickIntent,
	) => void;
	/** Esc 또는 stop()으로 끝났을 때. 토글 상태를 되돌리는 쪽이 쓴다. */
	onCancel?: () => void;
}

const HOST_ID = "dure-design-mode-overlay";

const OVERLAY_CSS = `
:host { all: initial; }
.root {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
}
.box {
  position: fixed;
  border: 1px solid rgba(59, 130, 246, 0.9);
  background: rgba(59, 130, 246, 0.14);
  pointer-events: none;
  transition: all 60ms linear;
}
.label {
  position: fixed;
  padding: 2px 6px;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #fff;
  background: rgba(37, 99, 235, 0.95);
  border-radius: 3px;
  pointer-events: none;
  white-space: nowrap;
}
.backdrop {
  position: fixed;
  inset: 0;
  pointer-events: auto;
}
.menu {
  position: fixed;
  min-width: 176px;
  padding: 4px;
  font: 12px/1.5 -apple-system, system-ui, sans-serif;
  color: #e5e5e5;
  background: rgba(23, 23, 23, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
}
.item {
  display: block;
  width: 100%;
  padding: 5px 8px;
  text-align: left;
  color: inherit;
  background: none;
  border: 0;
  border-radius: 5px;
  font: inherit;
  cursor: pointer;
}
.item:hover { background: rgba(255, 255, 255, 0.1); }
.sep { height: 1px; margin: 4px 2px; background: rgba(255, 255, 255, 0.12); }
`;

/**
 * 픽커를 켠다. 오버레이는 그리기 전용이고(pointer-events:none) 이벤트는 window
 * 캡처 단계에서 관찰한다 — 대상 판별은 elementFromPoint로 한다(오버레이 자신은
 * pointer-events:none이라 검색에서 자연히 빠진다).
 */
export function startDesignModePicker(
	callbacks: PickerCallbacks,
): PickerHandle {
	const host = document.createElement("div");
	host.id = HOST_ID;
	const shadow = host.attachShadow({ mode: "open" });
	const style = document.createElement("style");
	style.textContent = OVERLAY_CSS;
	const root = document.createElement("div");
	root.className = "root";
	const box = document.createElement("div");
	box.className = "box";
	const label = document.createElement("div");
	label.className = "label";
	root.append(box, label);
	shadow.append(style, root);
	document.body.append(host);

	let hovered: Element | null = null;
	/** hovered에서 위로 몇 단 올라간 것을 대상으로 볼지(ArrowUp).
	 *
	 *  초기화는 **hover 대상이 바뀔 때만** 한다. pointermove마다 초기화하면 넓힌
	 *  선택이 클릭 직전의 1px 흔들림에도 풀린다(실측: Playwright의 click이 move를
	 *  먼저 보내 넓힘이 매번 사라졌다. 실제 마우스도 같다). 같은 요소 위에서
	 *  움직이는 동안은 유지하고, 다른 요소로 넘어가면 되돌린다. */
	let depthOffset = 0;
	let stopped = false;
	/** 메뉴가 떠 있는 동안의 요소들. 열려 있으면 hover 갱신을 멈춘다 — 메뉴로
	 *  마우스를 옮기는 동안 대상이 바뀌면 무엇을 집는지가 흔들린다. */
	let menuParts: { backdrop: HTMLElement; menu: HTMLElement } | null = null;

	const targetFromHover = (): Element | null => {
		let element = hovered;
		for (
			let step = 0;
			step < depthOffset && element?.parentElement;
			step += 1
		) {
			const parent: Element = element.parentElement;
			if (parent === document.body) break;
			element = parent;
		}
		return element;
	};

	const targetAt = (x: number, y: number): Element | null => {
		// 오버레이는 pointer-events:none이라 elementFromPoint에 걸리지 않지만,
		// 혹시 모를 브라우저 차이에 대비해 잠시 숨기는 방어는 유지한다.
		host.style.display = "none";
		const found = document.elementFromPoint(x, y);
		host.style.display = "";
		if (
			!found ||
			found === document.documentElement ||
			found === document.body
		) {
			return null;
		}
		if (!isPickableTarget(found)) return null;
		return normalizePickTarget(found);
	};

	const paint = (element: Element | null) => {
		if (!element) {
			box.style.display = "none";
			label.style.display = "none";
			return;
		}
		const rect = element.getBoundingClientRect();
		box.style.display = "";
		box.style.left = `${rect.left}px`;
		box.style.top = `${rect.top}px`;
		box.style.width = `${rect.width}px`;
		box.style.height = `${rect.height}px`;
		label.style.display = "";
		label.textContent = `${element.tagName.toLowerCase()} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
		// 라벨이 화면 위로 잘리면 요소 안쪽으로 내린다.
		const above = rect.top - 18;
		label.style.left = `${Math.max(2, rect.left)}px`;
		label.style.top = `${above > 2 ? above : rect.top + 2}px`;
	};

	const closeMenu = () => {
		menuParts?.backdrop.remove();
		menuParts?.menu.remove();
		menuParts = null;
	};

	const pick = (element: Element, intent: PickIntent) => {
		// 캡처를 넘긴 뒤 픽커를 끈다 — 한 번 집으면 끝나는 계약은 유지한다.
		// page 컨텍스트(URL·뷰포트·스크롤)는 캡처 시점 값이라 여기서 시각을 넣는다.
		const captured = captureElement(element, { now: new Date().toISOString() });
		stop();
		callbacks.onPick(captured, element, intent);
	};

	const openMenu = (x: number, y: number, element: Element) => {
		closeMenu();
		const backdrop = document.createElement("div");
		backdrop.className = "backdrop";
		// 바깥 클릭은 메뉴만 닫는다 — 그 클릭이 앱에도 전달되면 의도치 않은
		// 동작(버튼 눌림)이 함께 일어난다.
		backdrop.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
			closeMenu();
		});
		const menu = document.createElement("div");
		menu.className = "menu";
		const item = (text: string, action: () => void) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "item";
			button.textContent = text;
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				action();
			});
			return button;
		};
		const separator = document.createElement("div");
		separator.className = "sep";
		menu.append(
			item("Type into agent prompt", () => pick(element, "send")),
			item("Copy to clipboard", () => pick(element, "copy")),
			separator,
			item("Exit Pinpoint", () => {
				stop();
				callbacks.onCancel?.();
			}),
		);
		root.append(backdrop, menu);
		// 뷰포트 밖으로 나가지 않게 붙인 뒤 측정해 자리를 잡는다.
		const rect = menu.getBoundingClientRect();
		menu.style.left = `${Math.min(x, Math.max(0, window.innerWidth - rect.width - 4))}px`;
		menu.style.top = `${Math.min(y, Math.max(0, window.innerHeight - rect.height - 4))}px`;
		menuParts = { backdrop, menu };
	};

	const onMove = (event: PointerEvent) => {
		if (menuParts) return;
		const next = targetAt(event.clientX, event.clientY);
		if (next !== hovered) {
			hovered = next;
			depthOffset = 0;
		}
		paint(targetFromHover());
	};

	const onContextMenu = (event: MouseEvent) => {
		const element =
			targetFromHover() ?? targetAt(event.clientX, event.clientY);
		// 집을 것이 없으면 브라우저 기본 메뉴를 막지 않는다.
		if (!element) return;
		event.preventDefault();
		event.stopPropagation();
		openMenu(event.clientX, event.clientY, element);
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			// 메뉴가 떠 있으면 메뉴만 닫는다 — 모드는 유지된다.
			if (menuParts) {
				closeMenu();
				return;
			}
			stop();
			callbacks.onCancel?.();
			return;
		}
		if (menuParts) return;
		// 아이콘·텍스트 span이 잡혔을 때 버튼·카드로 넓힌다. 어디까지 올릴지를
		// 추측하는 대신 사용자가 정한다.
		if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			if (!hovered) return;
			event.preventDefault();
			depthOffset =
				event.key === "ArrowUp"
					? depthOffset + 1
					: Math.max(0, depthOffset - 1);
			paint(targetFromHover());
		}
	};

	function stop() {
		if (stopped) return;
		stopped = true;
		closeMenu();
		window.removeEventListener("pointermove", onMove, true);
		window.removeEventListener("contextmenu", onContextMenu, true);
		window.removeEventListener("keydown", onKeyDown, true);
		host.remove();
	}

	// 전부 캡처 단계 — 페이지가 이벤트를 먼저 삼켜도(터미널·에디터) 픽커는
	// 관찰만 하고, contextmenu·Esc만 가로챈다.
	window.addEventListener("pointermove", onMove, true);
	window.addEventListener("contextmenu", onContextMenu, true);
	window.addEventListener("keydown", onKeyDown, true);

	return { stop };
}
