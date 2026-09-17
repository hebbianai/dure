/**
 * 요소 하나를 에이전트에게 설명할 수 있는 형태로 캡처한다 (Design Mode).
 *
 * **이 모듈은 다른 모듈을 import 하지 않는다.** B단계에서 사용자 앱 창에
 * `initialization_script`로 주입해야 하므로(다른 포트의 웹앱), 앱 런타임에
 * 의존하면 그때 통째로 다시 써야 한다. DOM API만 쓴다 — i18n·store·ipc 금지.
 *
 * 스타일 읽기를 주입 가능하게 둔 이유: jsdom의 getComputedStyle은 실제 값을
 * 거의 돌려주지 않아, 화이트리스트·잡음 제거 판정을 테스트할 수 없다. 기본값은
 * 실제 getComputedStyle이다.
 */

import {
	ancestorPath,
	type ElementAccessibility,
	elementAccessibility,
	elementSelector,
	nearbyText,
	type PageContext,
	pageContext,
	reactComponentName,
	selectedTextWithin,
} from "@/lib/design/designModeContext";

interface CapturedRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CapturedElement {
	/** 사람이 알아보는 짧은 이름 — `button.primary#save` */
	label: string;
	/** body에서 내려오는 경로 — `main > div.sidebar > button.primary` */
	path: string;
	html: string;
	/** html이 상한을 넘어 자식을 생략했는지. 에이전트가 "전체를 보여달라"고 물을
	 *  근거가 되므로 숨기지 않고 알린다. */
	htmlElided: boolean;
	css: Record<string, string>;
	rect: CapturedRect;
	/** dev 빌드에서 주입한 `data-dure-src`(파일:줄). 없으면 undefined. */
	source?: string;
	/** 다시 찾을 수 있는 셀렉터 — 같은 카드가 여럿일 때 무엇을 집었는지 남긴다. */
	selector: string;
	/** 조상 라벨(바깥 → 안). 이 요소가 어디에 속한 것인지. */
	ancestors: string[];
	/** 형제 텍스트 — "여러 개 중 어느 것"을 사람 말로 좁힌다. */
	nearby: string[];
	accessibility: ElementAccessibility;
	/** 페이지 기준 rect. 스크롤된 문서에서는 뷰포트 rect와 다르고, 스크린샷
	 *  좌표 변환에는 이쪽이 필요하다. */
	pageRect: CapturedRect;
	page?: PageContext;
	/** 사용자가 대상 안의 텍스트를 선택해 뒀다면 그것이 의도다. */
	selectedText?: string;
	/** React 컴포넌트 이름(알 수 있으면). 에이전트가 컴포넌트 단위로 고친다. */
	component?: string;
	/** 크롭 스크린샷 파일 경로. 화면 기록 권한이 없으면 없다(fail-open) — 없다는
	 *  것이 실패가 아니라 정상 경로의 한 갈래다. */
	screenshotPath?: string;
}

/** 에이전트에게 의미가 있는 속성만. computed style 전체(300+)를 넘기면 컨텍스트를
 *  태우고 정작 중요한 것이 묻힌다. */
const CAPTURED_CSS_PROPERTIES: readonly string[] = [
	"display",
	"position",
	"width",
	"height",
	"min-width",
	"min-height",
	"max-width",
	"max-height",
	"margin",
	"padding",
	"gap",
	"flex-direction",
	"align-items",
	"justify-content",
	"flex",
	"grid-template-columns",
	"color",
	"background-color",
	"border",
	"border-radius",
	"box-shadow",
	"outline",
	"font-family",
	"font-size",
	"font-weight",
	"line-height",
	"letter-spacing",
	"text-align",
	"text-decoration",
	"opacity",
	"overflow",
	"z-index",
	"transform",
	"transition",
];

/** 값이 있으나 아무것도 말해주지 않는 것들 — 이걸 남기면 실제 스타일이 잡음에
 *  묻힌다. `0px`는 margin/padding이 없다는 뜻이라 대개 불필요하다. */
const NOISE_VALUES = new Set([
	"",
	"none",
	"normal",
	"auto",
	"0px",
	"0px 0px",
	"0%",
	"rgba(0, 0, 0, 0)",
	"transparent",
]);

/** 기본 상한. 큰 컴포넌트의 outerHTML은 수만 토큰이 된다. */
const DEFAULT_HTML_LIMIT_BYTES = 4_000;

function classPart(element: Element): string {
	const classes = Array.from(element.classList).slice(0, 2);
	return classes.length > 0 ? `.${classes.join(".")}` : "";
}

export function elementLabel(element: Element): string {
	const tag = element.tagName.toLowerCase();
	const id = element.id ? `#${element.id}` : "";
	return `${tag}${classPart(element)}${id}`;
}

/** 조상 경로. 너무 길면 읽기 어렵고 토큰만 먹으므로 깊이를 제한한다. */
export function elementPath(element: Element, maxDepth = 4): string {
	const parts: string[] = [];
	let current: Element | null = element;
	while (current && parts.length < maxDepth) {
		if (current.tagName.toLowerCase() === "body") break;
		parts.unshift(elementLabel(current));
		current = current.parentElement;
	}
	return parts.join(" > ");
}

/** 잡음 값을 걸러 의미 있는 것만 남긴다. 주입된 스크립트가 보낸 평범한 레코드도
 *  같은 필터를 통과해야 한다 — 그래서 getPropertyValue 형태와 레코드 둘 다 받는다. */
export function filterCapturedCss(
	values: Record<string, string>,
): Record<string, string> {
	const css: Record<string, string> = {};
	for (const [property, raw] of Object.entries(values)) {
		const value = raw?.trim() ?? "";
		if (NOISE_VALUES.has(value)) continue;
		css[property] = value;
	}
	return css;
}

export function capturedCss(
	style: Pick<CSSStyleDeclaration, "getPropertyValue">,
	properties: readonly string[] = CAPTURED_CSS_PROPERTIES,
): Record<string, string> {
	const css: Record<string, string> = {};
	for (const property of properties) {
		const value = style.getPropertyValue(property)?.trim() ?? "";
		if (NOISE_VALUES.has(value)) continue;
		css[property] = value;
	}
	return css;
}

/** 여는 태그만 — 자식을 생략할 때 쓴다. 주입된 스크립트도 같은 형태를 만든다. */
export function openingTag(element: Element): string {
	const attributes = Array.from(element.attributes)
		.map((attribute) => ` ${attribute.name}="${attribute.value}"`)
		.join("");
	return `<${element.tagName.toLowerCase()}${attributes}>`;
}

/**
 * outerHTML을 상한 안으로. 넘으면 자식을 생략하고 몇 개를 생략했는지 남긴다.
 * 잘라내기(substring)를 하지 않는 이유: 태그 중간에서 끊긴 HTML은 에이전트가
 * 구조를 오해할 수 있다. 생략은 구조를 유지한다.
 *
 * Element가 아니라 값(html·자식 수·여는 태그)을 받는다 — B단계에서 주입된
 * 스크립트가 다른 창에서 수집해 보내는 페이로드에도 **같은 판정**을 써야 하기
 * 때문이다. 판정이 두 곳으로 갈라지면 창마다
 * 다른 결과가 나온다.
 */
export function elideHtml(input: {
	html: string;
	childCount: number;
	tagName: string;
	openingTag: string;
	limitBytes?: number;
}): { html: string; elided: boolean } {
	const limit = input.limitBytes ?? DEFAULT_HTML_LIMIT_BYTES;
	if (byteLength(input.html) <= limit) {
		return { html: input.html, elided: false };
	}
	const body =
		input.childCount > 0
			? `\n  <!-- ${input.childCount} child element(s) elided -->\n`
			: "\n  <!-- content elided -->\n";
	return {
		html: `${input.openingTag}${body}</${input.tagName}>`,
		elided: true,
	};
}

/** 같은 판정을 이 창의 Element에 적용한다. */
export function capturedHtml(
	element: Element,
	limitBytes = DEFAULT_HTML_LIMIT_BYTES,
): { html: string; elided: boolean } {
	return elideHtml({
		html: element.outerHTML,
		childCount: element.children.length,
		tagName: element.tagName.toLowerCase(),
		openingTag: openingTag(element),
		limitBytes,
	});
}

function byteLength(text: string): number {
	// TextEncoder가 없는 환경(오래된 webview)에서도 동작해야 한다 — 주입 대상은
	// 우리가 고른 페이지가 아니다.
	return typeof TextEncoder === "function"
		? new TextEncoder().encode(text).byteLength
		: text.length;
}

export interface CaptureOptions {
	limitBytes?: number;
	/** 페이지 컨텍스트의 시각. 테스트가 고정할 수 있게 주입받는다. */
	now?: string;
	/** 테스트·비-브라우저 환경용. 기본값은 window.getComputedStyle. */
	readStyle?: (
		element: Element,
	) => Pick<CSSStyleDeclaration, "getPropertyValue">;
}

export function captureElement(
	element: Element,
	options: CaptureOptions = {},
): CapturedElement {
	const readStyle =
		options.readStyle ??
		((target: Element) => window.getComputedStyle(target as HTMLElement));
	const box = element.getBoundingClientRect();
	const { html, elided } = capturedHtml(element, options.limitBytes);
	const source = element.getAttribute("data-dure-src") ?? undefined;
	const view = element.ownerDocument.defaultView;
	const scrollX = view?.scrollX ?? 0;
	const scrollY = view?.scrollY ?? 0;
	const selectedText = selectedTextWithin(element);
	const component = reactComponentName(element);
	return {
		label: elementLabel(element),
		path: elementPath(element),
		selector: elementSelector(element),
		ancestors: ancestorPath(element),
		nearby: nearbyText(element),
		accessibility: elementAccessibility(element),
		html,
		htmlElided: elided,
		css: capturedCss(readStyle(element)),
		rect: {
			x: Math.round(box.left),
			y: Math.round(box.top),
			width: Math.round(box.width),
			height: Math.round(box.height),
		},
		pageRect: {
			x: Math.round(box.left + scrollX),
			y: Math.round(box.top + scrollY),
			width: Math.round(box.width),
			height: Math.round(box.height),
		},
		...(view && options.now ? { page: pageContext(view, options.now) } : {}),
		...(source ? { source } : {}),
		...(selectedText ? { selectedText } : {}),
		...(component ? { component } : {}),
	};
}

/**
 * 집을 대상으로 정규화한다. elementFromPoint는 가장 깊은 요소를 주는데, svg
 * 내부(path·g·circle)는 편집할 UI가 아니라 아이콘 한 덩어리의 부품이다 —
 * 실측에서 버튼을 집으려 하면 그 안의 `<path>`가 잡혔다. svg는 시각적으로
 * 원자이므로 svg 자체를 대상으로 올린다. 더 위(버튼·카드)로 가려면 픽커의
 * 방향키로 사용자가 올린다 — 어디까지 올릴지는 추측할 일이 아니다.
 */
export function normalizePickTarget(element: Element): Element {
	const svg = element.closest("svg");
	return svg ?? element;
}

/**
 * 픽커에서 제외할 영역인지. 터미널(xterm 캔버스)과 에디터(CodeMirror) 내부는
 * DOM으로 집어도 의미가 없다 — 그 안은 렌더 결과이지 우리가 고칠 마크업이
 * 아니다. 대신 그 컨테이너 자체는 집을 수 있어야 하므로 내부만 제외한다.
 */
export function isPickableTarget(element: Element): boolean {
	const excluded = element.closest(
		".xterm-screen, .xterm-rows, .cm-content, .cm-gutters",
	);
	return excluded === null;
}
