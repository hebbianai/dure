// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NewFolderIcon } from "@/components/sidebar/NewFolderIcon";

/** 이 컴포넌트의 값어치는 전부 좌표에 있다 — 시안 SVG를 24 그리드로 역산한
 *  값이라 한 글자만 틀려도 화면에서는 "비슷한 폴더 아이콘"으로 보이고 아무
 *  테스트도 깨지지 않는다. 그래서 path를 그대로 못 박는다. */
describe("NewFolderIcon", () => {
	const paths = () => {
		const { container } = render(<NewFolderIcon />);
		return [...container.querySelectorAll("path")].map((p) => p.getAttribute("d"));
	};

	/** 폴더 몸통은 lucide folder와 같은 좌표를 지나되 닫히지 않는다 — 끝의
	 *  v3.5가 왼쪽 아래를 열어 두어 더하기가 앉을 자리를 만든다. Z가 붙거나
	 *  v3.5가 사라지면 시안과 다른 아이콘이 된다. */
	it("draws an open folder body", () => {
		const body = paths()[0] ?? "";
		expect(body).toContain("M4 20h16");
		expect(body.endsWith("v3.5")).toBe(true);
		expect(body).not.toContain("Z");
	});

	/** lucide folder-plus는 더하기가 폴더 안 중앙(12,13)이다. 시안은 왼쪽
	 *  모서리(4,14)이고 그 차이가 이 컴포넌트의 존재 이유다. */
	it("puts the plus on the folder's left edge, not inside it", () => {
		expect(paths().slice(1)).toEqual(["M4 11v6", "M1 14h6"]);
	});

	/** 이름은 감싼 버튼의 title/aria-label이 말한다 — 아이콘이 같은 정보를
	 *  두 번 보내지 않는다. */
	it("is decorative", () => {
		const { container } = render(<NewFolderIcon />);
		expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
	});

	/** 24 그리드 규격을 RailIcons와 공유한다 — 어긋나면 같은 size-3.5를 줘도
	 *  옆 lucide 아이콘보다 크거나 작아 보인다(그 파일 doc 주석의 실제 사고). */
	it("shares the lucide 24-grid spec", () => {
		const { container } = render(<NewFolderIcon />);
		const svg = container.querySelector("svg");
		expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
		expect(svg?.getAttribute("stroke-width")).toBe("2");
		expect(svg?.getAttribute("fill")).toBe("none");
	});
});
