// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	ancestorPath,
	elementAccessibility,
	elementSelector,
	nearbyText,
	pageContext,
	selectedTextWithin,
	trimText,
} from "@/lib/design/designModeContext";

function mount(html: string): HTMLElement {
	document.body.innerHTML = html;
	return document.body.firstElementChild as HTMLElement;
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("trimText", () => {
	it("공백을 접고 상한에서 자른다 — 컨텍스트 폭탄 방어", () => {
		expect(trimText("  a\n\n  b  ")).toBe("a b");
		expect(trimText("x".repeat(300)).endsWith("…")).toBe(true);
		expect(trimText("x".repeat(300)).length).toBeLessThanOrEqual(241);
	});

	it("없는 값은 빈 문자열", () => {
		expect(trimText(null)).toBe("");
	});
});

describe("elementAccessibility", () => {
	// 사람이 "이 버튼"이라고 부를 때 쓰는 이름이 접근성 이름이다.
	it("aria-label이 가장 강하다", () => {
		const el = mount(`<button aria-label="저장">💾</button>`);
		expect(elementAccessibility(el).accessibleName).toBe("저장");
	});

	it("aria-labelledby가 가리키는 텍스트를 읽는다", () => {
		mount(
			`<div><span id="lbl">파일 저장</span><button aria-labelledby="lbl"></button></div>`,
		);
		const button = document.querySelector("button") as Element;
		expect(elementAccessibility(button).accessibleName).toBe("파일 저장");
	});

	it("없으면 보이는 텍스트로 근사한다", () => {
		expect(
			elementAccessibility(mount(`<button>Save changes</button>`))
				.accessibleName,
		).toBe("Save changes");
	});

	it("role과 aria 속성을 그대로 담는다", () => {
		const a11y = elementAccessibility(
			mount(`<div role="dialog" aria-label="설정"></div>`),
		);
		expect(a11y.role).toBe("dialog");
		expect(a11y.ariaLabel).toBe("설정");
	});

	it("이름을 못 찾으면 그 키를 만들지 않는다", () => {
		expect("accessibleName" in elementAccessibility(mount("<div></div>"))).toBe(
			false,
		);
	});
});

describe("elementSelector", () => {
	it("id가 있으면 그것으로 끝낸다", () => {
		expect(elementSelector(mount(`<div id="root"></div>`))).toBe("#root");
	});

	// 같은 카드가 12개일 때 클래스만으로는 무엇을 집었는지 구분되지 않는다.
	it("형제가 여럿이면 nth-of-type으로 구분한다", () => {
		mount(
			`<ul><li class="c">1</li><li class="c">2</li><li class="c">3</li></ul>`,
		);
		const second = document.querySelectorAll("li")[1] as Element;
		expect(elementSelector(second)).toBe("ul > li.c:nth-of-type(2)");
	});

	it("형제가 하나면 nth를 붙이지 않는다", () => {
		mount(`<main><section class="s"><p>x</p></section></main>`);
		const p = document.querySelector("p") as Element;
		expect(elementSelector(p)).toBe("main > section.s > p");
	});

	it("조상 중 id를 만나면 거기서 멈춘다", () => {
		mount(`<div id="app"><div class="wrap"><span>x</span></div></div>`);
		const span = document.querySelector("span") as Element;
		expect(elementSelector(span)).toBe("#app > div.wrap > span");
	});
});

describe("ancestorPath / nearbyText", () => {
	it("조상 라벨을 바깥에서 안으로 담는다", () => {
		mount(
			`<main><div class="a"><div class="b"><button>x</button></div></div></main>`,
		);
		const button = document.querySelector("button") as Element;
		expect(ancestorPath(button)).toEqual(["main", "div.a", "div.b"]);
	});

	it("형제 텍스트로 주변을 설명한다", () => {
		mount(`<ul><li>첫째</li><li>둘째</li><li>셋째</li><li>넷째</li></ul>`);
		const second = document.querySelectorAll("li")[1] as Element;
		expect(nearbyText(second)).toEqual(["첫째", "셋째", "넷째"]);
	});

	it("부모가 없으면 빈 목록", () => {
		expect(nearbyText(document.documentElement)).toEqual([]);
	});
});

describe("selectedTextWithin", () => {
	it("선택이 없으면 undefined", () => {
		expect(selectedTextWithin(mount("<p>text</p>"))).toBeUndefined();
	});

	it("대상 안의 선택은 의도로 본다", () => {
		const p = mount("<p>hello world</p>");
		const range = document.createRange();
		range.selectNodeContents(p.firstChild as Node);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		expect(selectedTextWithin(p)).toBe("hello world");
	});

	it("대상 밖의 선택은 무시한다", () => {
		mount(`<div><p id="a">aaa</p><p id="b">bbb</p></div>`);
		const a = document.getElementById("a") as Element;
		const b = document.getElementById("b") as Element;
		const range = document.createRange();
		range.selectNodeContents(b.firstChild as Node);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		expect(selectedTextWithin(a)).toBeUndefined();
	});
});

describe("pageContext", () => {
	it("URL·뷰포트·스크롤·DPR·시각을 담는다", () => {
		const context = pageContext(window, "2026-07-30T00:00:00.000Z");
		expect(context.url).toBe(window.location.href);
		expect(context.viewportWidth).toBe(window.innerWidth);
		expect(context.capturedAt).toBe("2026-07-30T00:00:00.000Z");
		expect(typeof context.devicePixelRatio).toBe("number");
	});
});
