import { describe, expect, it } from "vitest";
import type { CapturedElement } from "@/lib/design/designModeCapture";
import { formatCapturedElement } from "@/lib/design/designModePrompt";

const base: CapturedElement = {
	label: "button.save",
	path: "main > button.save",
	selector: "main > button.save",
	ancestors: ["main"],
	nearby: [],
	accessibility: {},
	html: '<button class="save">Save</button>',
	htmlElided: false,
	css: { color: "rgb(1, 2, 3)", display: "inline-flex" },
	rect: { x: 10, y: 20, width: 80, height: 32 },
	pageRect: { x: 10, y: 120, width: 80, height: 32 },
};

describe("formatCapturedElement", () => {
	it("사용자가 쓸 자리를 맨 앞에 둔다", () => {
		const first = formatCapturedElement(base).split("\n")[0];
		expect(first).toContain("이 위에 쓰세요");
	});

	it("요소·경로·크기·HTML·CSS를 담는다", () => {
		const text = formatCapturedElement(base);
		expect(text).toContain("요소: button.save");
		expect(text).toContain("셀렉터: main > button.save");
		expect(text).toContain("80×32");
		expect(text).toContain('<button class="save">Save</button>');
		expect(text).toContain("color: rgb(1, 2, 3);");
	});

	it("소스 위치가 있으면 함께 담는다", () => {
		expect(
			formatCapturedElement({ ...base, source: "src/components/Foo.tsx:42" }),
		).toContain("소스: src/components/Foo.tsx:42");
	});

	it("소스 위치가 없으면 그 줄을 만들지 않는다", () => {
		expect(formatCapturedElement(base)).not.toContain("소스:");
	});

	// 생략을 숨기면 에이전트가 전체를 봤다고 착각한다.
	it("자식이 생략됐으면 그 사실을 알린다", () => {
		expect(formatCapturedElement({ ...base, htmlElided: true })).toContain(
			"생략됐습니다",
		);
	});

	// 사람이 이 요소를 부르는 이름이 태그·클래스보다 먼저 필요하다.
	it("접근성 이름을 요소 줄에 붙인다", () => {
		expect(
			formatCapturedElement({
				...base,
				accessibility: { accessibleName: "저장", role: "button" },
			}),
		).toContain('요소: button.save — "저장"');
	});

	it("컴포넌트 이름·셀렉터·위치를 담는다", () => {
		const text = formatCapturedElement({
			...base,
			component: "SaveButton",
			ancestors: ["main", "form.settings"],
		});
		expect(text).toContain("컴포넌트: SaveButton");
		expect(text).toContain("셀렉터: main > button.save");
		expect(text).toContain("위치: main > form.settings");
	});

	// 같은 모양이 여럿일 때 어느 것인지를 사람 말로 좁힌다.
	it("주변 항목으로 대상을 좁힌다", () => {
		expect(
			formatCapturedElement({ ...base, nearby: ["취소", "삭제"] }),
		).toContain('주변 항목: "취소", "삭제"');
	});

	it("선택해 둔 텍스트가 있으면 의도로 담는다", () => {
		expect(
			formatCapturedElement({ ...base, selectedText: "여기 오타" }),
		).toContain('선택한 텍스트: "여기 오타"');
	});

	it("페이지 URL은 있을 때만 담는다", () => {
		expect(formatCapturedElement(base)).not.toContain("페이지:");
		expect(
			formatCapturedElement({
				...base,
				page: {
					url: "http://localhost:3000/settings",
					title: "t",
					viewportWidth: 1,
					viewportHeight: 1,
					scrollX: 0,
					scrollY: 0,
					devicePixelRatio: 2,
					capturedAt: "2026-07-30T00:00:00.000Z",
				},
			}),
		).toContain("페이지: http://localhost:3000/settings");
	});

	it("CSS가 비면 그 섹션을 만들지 않는다", () => {
		expect(formatCapturedElement({ ...base, css: {} })).not.toContain("CSS");
	});
});

// 스크린샷은 "있으면 좋은 것"이다. 권한이 없으면 없고, 그것이 실패가 아니라 정상
// 경로의 한 갈래다 — 두 갈래를 모두 고정한다.
describe("스크린샷 경로", () => {
	it("있으면 경로를 담는다 — 이미지를 텍스트에 인라인할 수는 없다", () => {
		expect(
			formatCapturedElement({
				...base,
				screenshotPath: "/tmp/dure-design-1.png",
			}),
		).toContain("스크린샷: /tmp/dure-design-1.png");
	});

	it("없으면 그 줄을 만들지 않는다", () => {
		expect(formatCapturedElement(base)).not.toContain("스크린샷:");
	});
});

describe("formatRedesignMockupPrompt", () => {
	it("prefixes the mockup directive and keeps the capture payload intact", async () => {
		const { formatRedesignMockupPrompt } = await import("./designModePrompt");
		const wrapped = formatRedesignMockupPrompt("## Button\n```css\ncolor: red;\n```");
		expect(wrapped).toContain("design/mockups/<cluster>/<ComponentName>/<state>.html");
		expect(wrapped).toContain("design/SOUL.md");
		expect(wrapped).toContain("제품 코드를 직접 고치지 말고,");
		expect(wrapped.endsWith("## Button\n```css\ncolor: red;\n```")).toBe(true);
	});
});
