// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	capturedCss,
	capturedHtml,
	captureElement,
	elementLabel,
	elementPath,
	elideHtml,
	filterCapturedCss,
	isPickableTarget,
	normalizePickTarget,
	openingTag,
} from "@/lib/design/designModeCapture";

function mount(html: string): HTMLElement {
	document.body.innerHTML = html;
	return document.body.firstElementChild as HTMLElement;
}

/** getComputedStyle을 대신한다 — jsdom은 실제 값을 거의 돌려주지 않는다. */
function fakeStyle(values: Record<string, string>) {
	return { getPropertyValue: (property: string) => values[property] ?? "" };
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("elementLabel / elementPath", () => {
	it("태그·클래스·id를 짧게 합친다", () => {
		const element = mount(
			`<button class="primary lg extra" id="save"></button>`,
		);
		// 클래스는 둘까지 — 유틸리티 클래스가 20개인 곳에서 라벨이 문단이 된다.
		expect(elementLabel(element)).toBe("button.primary.lg#save");
	});

	it("클래스도 id도 없으면 태그만", () => {
		expect(elementLabel(mount("<section></section>"))).toBe("section");
	});

	it("body까지 올라가되 body는 넣지 않는다", () => {
		mount(
			`<main><div class="sidebar"><button class="x"></button></div></main>`,
		);
		const button = document.querySelector("button") as Element;
		expect(elementPath(button)).toBe("main > div.sidebar > button.x");
	});

	it("깊이를 제한한다 — 경로가 길면 읽기 어렵고 토큰만 먹는다", () => {
		mount(
			"<div><div><div><div><div><span></span></div></div></div></div></div>",
		);
		const span = document.querySelector("span") as Element;
		expect(elementPath(span, 3).split(" > ")).toHaveLength(3);
		expect(elementPath(span, 3).endsWith("span")).toBe(true);
	});
});

describe("capturedCss", () => {
	it("화이트리스트에 있는 속성만 뽑는다", () => {
		const css = capturedCss(
			fakeStyle({
				color: "rgb(255, 0, 0)",
				"-webkit-font-smoothing": "antialiased",
			}),
		);
		expect(css.color).toBe("rgb(255, 0, 0)");
		expect(css["-webkit-font-smoothing"]).toBeUndefined();
	});

	// 잡음을 남기면 실제 스타일이 그 안에 묻힌다.
	it("아무것도 말해주지 않는 값은 버린다", () => {
		const css = capturedCss(
			fakeStyle({
				display: "flex",
				margin: "0px",
				"background-color": "rgba(0, 0, 0, 0)",
				transform: "none",
				"letter-spacing": "normal",
			}),
		);
		expect(css).toEqual({ display: "flex" });
	});
});

describe("capturedHtml", () => {
	it("상한 아래면 그대로 준다", () => {
		const element = mount(`<div class="a"><span>hi</span></div>`);
		const { html, elided } = capturedHtml(element, 1_000);
		expect(elided).toBe(false);
		expect(html).toContain("<span>hi</span>");
	});

	// 잘라내면 태그 중간에서 끊겨 에이전트가 구조를 오해한다 — 생략은 구조를 지킨다.
	it("상한을 넘으면 자식을 생략하고 개수를 남긴다", () => {
		const children = Array.from(
			{ length: 12 },
			(_, i) => `<p>item ${i} ${"x".repeat(80)}</p>`,
		);
		const element = mount(
			`<div class="list" data-k="v">${children.join("")}</div>`,
		);
		const { html, elided } = capturedHtml(element, 200);
		expect(elided).toBe(true);
		expect(html).toContain("12 child element(s) elided");
		// 여는 태그의 속성은 유지된다 — 그게 스타일을 설명하는 단서다.
		expect(html).toContain(`class="list"`);
		expect(html).toContain(`data-k="v"`);
		expect(html.endsWith("</div>")).toBe(true);
	});

	it("자식 없이 긴 텍스트면 내용만 생략한다", () => {
		const element = mount(`<p>${"긴 텍스트 ".repeat(200)}</p>`);
		const { html, elided } = capturedHtml(element, 100);
		expect(elided).toBe(true);
		expect(html).toContain("content elided");
	});
});

describe("captureElement", () => {
	it("라벨·경로·css·rect를 한 묶음으로 준다", () => {
		mount(`<main><button class="primary">Save</button></main>`);
		const button = document.querySelector("button") as Element;
		const captured = captureElement(button, {
			readStyle: () =>
				fakeStyle({ color: "rgb(1, 2, 3)", display: "inline-flex" }),
		});
		expect(captured.label).toBe("button.primary");
		expect(captured.path).toBe("main > button.primary");
		expect(captured.css).toEqual({
			color: "rgb(1, 2, 3)",
			display: "inline-flex",
		});
		expect(captured.html).toContain("Save");
		expect(captured.htmlElided).toBe(false);
		expect(captured.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
	});

	it("dev 빌드의 소스 위치를 함께 준다", () => {
		const element = mount(
			`<div data-dure-src="src/components/Foo.tsx:42"></div>`,
		);
		expect(
			captureElement(element, { readStyle: () => fakeStyle({}) }).source,
		).toBe("src/components/Foo.tsx:42");
	});

	it("소스 위치가 없으면 그 키를 만들지 않는다", () => {
		const element = mount("<div></div>");
		const captured = captureElement(element, {
			readStyle: () => fakeStyle({}),
		});
		expect("source" in captured).toBe(false);
	});
});

describe("isPickableTarget", () => {
	// 터미널·에디터 내부는 렌더 결과이지 우리가 고칠 마크업이 아니다.
	it("터미널 화면 내부는 집지 않는다", () => {
		mount(
			`<div class="xterm-screen"><div class="xterm-rows"><span>$</span></div></div>`,
		);
		expect(isPickableTarget(document.querySelector("span") as Element)).toBe(
			false,
		);
	});

	it("에디터 내용 영역 내부는 집지 않는다", () => {
		mount(`<div class="cm-content"><span class="tok">const</span></div>`);
		expect(isPickableTarget(document.querySelector(".tok") as Element)).toBe(
			false,
		);
	});

	// 컨테이너 자체는 집을 수 있어야 한다 — pane 크롬을 고치려면 그게 대상이다.
	it("터미널을 감싼 pane 컨테이너는 집을 수 있다", () => {
		const pane = mount(
			`<div class="pane"><div class="xterm-screen"></div></div>`,
		);
		expect(isPickableTarget(pane)).toBe(true);
	});

	it("일반 요소는 집을 수 있다", () => {
		expect(isPickableTarget(mount(`<button></button>`))).toBe(true);
	});
});

describe("normalizePickTarget", () => {
	// 실측: 버튼을 집으려 하면 그 안의 <path>가 잡혔다. 아이콘 내부는 편집할 UI가
	// 아니라 한 덩어리의 부품이다.
	it("svg 내부를 집으면 svg 자체로 올린다", () => {
		mount(`<button><svg class="icon"><path d="M0 0"/></svg></button>`);
		const path = document.querySelector("path") as Element;
		expect(normalizePickTarget(path).tagName.toLowerCase()).toBe("svg");
	});

	it("svg 자체는 그대로 둔다", () => {
		mount(`<svg class="icon"></svg>`);
		const svg = document.querySelector("svg") as Element;
		expect(normalizePickTarget(svg)).toBe(svg);
	});

	// 더 위로 올릴지는 사용자가 방향키로 정한다 — 추측으로 버튼까지 올리지 않는다.
	it("일반 요소는 올리지 않는다", () => {
		const button = mount(`<button class="save">Save</button>`);
		expect(normalizePickTarget(button)).toBe(button);
	});
});

// B단계(다른 창의 사용자 앱)에서는 Element를 넘길 수 없어 값으로 온다. 판정이
// 두 곳으로 갈라지면 창마다 다른 결과가 나오므로 같은 함수를 쓴다.
describe("elideHtml (주입 경계용)", () => {
	const base = {
		html: '<div class="a">short</div>',
		childCount: 0,
		tagName: "div",
		openingTag: '<div class="a">',
	};

	it("상한 아래면 그대로", () => {
		expect(elideHtml({ ...base, limitBytes: 1000 })).toEqual({
			html: base.html,
			elided: false,
		});
	});

	it("상한을 넘으면 자식 수를 남기고 생략한다", () => {
		const result = elideHtml({
			...base,
			html: `<div class="a">${"x".repeat(500)}</div>`,
			childCount: 7,
			limitBytes: 50,
		});
		expect(result.elided).toBe(true);
		expect(result.html).toContain("7 child element(s) elided");
		expect(result.html).toContain('<div class="a">');
		expect(result.html.endsWith("</div>")).toBe(true);
	});

	it("자식이 없으면 내용 생략으로 표시한다", () => {
		const result = elideHtml({
			...base,
			html: `<div class="a">${"x".repeat(500)}</div>`,
			limitBytes: 50,
		});
		expect(result.html).toContain("content elided");
	});

	// Element를 받는 쪽과 값을 받는 쪽이 같은 결과여야 한다.
	it("같은 요소에 대해 capturedHtml과 결과가 일치한다", () => {
		const element = mount(`<p class="t">${"긴 텍스트 ".repeat(100)}</p>`);
		const viaElement = capturedHtml(element, 80);
		const viaValues = elideHtml({
			html: element.outerHTML,
			childCount: element.children.length,
			tagName: "p",
			openingTag: openingTag(element),
			limitBytes: 80,
		});
		expect(viaValues).toEqual(viaElement);
	});
});

describe("filterCapturedCss (주입 경계용)", () => {
	it("잡음 값을 같은 규칙으로 버린다", () => {
		expect(
			filterCapturedCss({
				display: "flex",
				margin: "0px",
				transform: "none",
				color: "rgb(1, 2, 3)",
			}),
		).toEqual({ display: "flex", color: "rgb(1, 2, 3)" });
	});

	it("빈 값과 누락을 안전하게 다룬다", () => {
		expect(filterCapturedCss({ color: "", gap: "  " })).toEqual({});
	});
});
