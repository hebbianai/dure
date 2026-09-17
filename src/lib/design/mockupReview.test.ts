// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { describeMockupElement, formatMockupComment } from "./mockupReview";

describe("describeMockupElement", () => {
	it("builds a short ancestor path with ids, classes, and a text snippet", () => {
		document.body.innerHTML = `
			<main id="root"><section class="card list dense extra"><button class="cta">저장하기</button></section></main>
		`;
		const button = document.querySelector("button");
		if (!button) throw new Error("fixture missing button");
		const anchor = describeMockupElement(button);
		expect(anchor).toContain("main#root > section.card.list.dense > button.cta");
		expect(anchor).toContain('"저장하기"');
	});

	it("omits the text clause for empty elements", () => {
		document.body.innerHTML = `<div><span class="dot"></span></div>`;
		const span = document.querySelector("span");
		if (!span) throw new Error("fixture missing span");
		expect(describeMockupElement(span)).not.toContain("—");
	});
});

describe("formatMockupComment", () => {
	it("names the file, anchor, request, and the SOUL judgment pointer", () => {
		const prompt = formatMockupComment({
			path: "design/mockups/spaces/SpacesPane/empty.html",
			anchor: 'button.cta — "저장하기"',
			comment: "  여백이 좁아요 — 상하 8px로  ",
		});
		expect(prompt).toContain("[목업 리뷰] design/mockups/spaces/SpacesPane/empty.html");
		expect(prompt).toContain('대상: button.cta — "저장하기"');
		expect(prompt).toContain("요청: 여백이 좁아요 — 상하 8px로");
		expect(prompt).toContain("design/SOUL.md");
	});
});
