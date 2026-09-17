// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileGlyph } from "@/components/sidebar/FileGlyph";

describe("FileGlyph", () => {
	/** 파일명이 바로 옆에 있으므로 아이콘이 보조기술에 같은 정보를 두 번
	 *  보내면 안 된다. FileTypeIcon 시절부터 지키던 계약이다. */
	it("is decorative — hidden from assistive tech", () => {
		const { container } = render(<FileGlyph />);
		const glyph = container.querySelector("[data-file-glyph]");
		expect(glyph?.getAttribute("aria-hidden")).toBe("true");
	});

	/** shrink-0이 빠지면 truncate되는 긴 파일명 옆에서 글리프가 눌려
	 *  목록의 아이콘 열이 행마다 어긋난다 — 시각 스냅샷 없이 잡는 훅. */
	it("keeps the icon column fixed at 12px", () => {
		const { container } = render(<FileGlyph />);
		const className = container.querySelector("[data-file-glyph]")?.getAttribute("class") ?? "";
		expect(className).toContain("size-3");
		expect(className).toContain("shrink-0");
	});
});
