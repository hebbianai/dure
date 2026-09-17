// @vitest-environment jsdom
// 프로바이더 아이콘은 전부 회색조다.
//
// 왜 테스트가 필요한가: 색이 나오는 경로가 세 갈래로 나뉘어 있어 한 곳만 고치면
// 나머지가 남는다 — (1) ProviderGlyph의 claude/codex 인라인 SVG 기본색,
// (2) ProviderBadge 상자의 테두리·배경 틴트, (3) 호출부가 className으로 덮어쓰는
// 색(tailwind-merge라 컴포넌트 기본색을 이긴다). 실제로 2026-08-11 실측에서
// 유채색이 22곳 남아 있었고 그중 8곳이 (2)였다.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ProviderBadge, ProviderGlyph } from "@/components/agents/ProviderLogo";
import { PROVIDER_IDS } from "@/lib/agents/providers";

/** 브랜드 틴트 토큰을 타는 클래스 — 하나라도 남으면 그 자리는 유채색이다. */
const BRAND = /agent-(claude|codex|kimi)-(icon|fill)/;

afterEach(cleanup);

describe("프로바이더 아이콘 회색조", () => {
	it("renders Pi as a shared inline glyph without its background tile", () => {
		const { container } = render(<ProviderGlyph provider="pi" />);
		expect(container.querySelector("img")).toBeNull();
		const glyph = container.querySelector("svg");
		expect(glyph).toBeTruthy();
		expect(glyph?.querySelector("rect")).toBeNull();
		expect(glyph?.getAttribute("class") ?? "").toContain(
			"text-muted-foreground",
		);
	});

	it("글리프에 브랜드 색 클래스를 달지 않는다", () => {
		for (const provider of PROVIDER_IDS) {
			const { container } = render(<ProviderGlyph provider={provider} />);
			const glyph = container.querySelector("svg, img");
			expect(glyph, provider).toBeTruthy();
			expect(glyph?.getAttribute("class") ?? "", provider).not.toMatch(BRAND);
			cleanup();
		}
	});

	// 상자는 글리프와 별개 경로다 — 글리프만 회색으로 바꾸면 틴트 면이 남는다.
	it("배지 상자의 테두리·배경에도 브랜드 틴트를 쓰지 않는다", () => {
		for (const provider of PROVIDER_IDS) {
			const { container } = render(<ProviderBadge provider={provider} />);
			const box = container.firstElementChild;
			expect(box, provider).toBeTruthy();
			expect(box?.getAttribute("class") ?? "", provider).not.toMatch(BRAND);
			cleanup();
		}
	});

	// 인라인 SVG가 색을 하드코딩하면 className을 아무리 고쳐도 유채색이 남는다.
	it("인라인 SVG는 색을 하드코딩하지 않고 currentColor만 쓴다", () => {
		for (const provider of PROVIDER_IDS) {
			const { container } = render(<ProviderGlyph provider={provider} />);
			for (const el of container.querySelectorAll("svg *, svg")) {
				for (const attr of ["fill", "stroke"]) {
					const value = el.getAttribute(attr);
					if (value === null) continue;
					expect(["currentColor", "none"], `${provider} ${el.tagName}[${attr}]`).toContain(
						value,
					);
				}
			}
			cleanup();
		}
	});

	// 모든 provider가 같은 톤으로 읽혀야 한다. 시안 2496:59514의 글리프 잉크는
	// rgb(163,163,163)으로 보조 텍스트와 같은 값이었다 — 그게 muted-foreground다.
	it("색을 직접 칠하는 글리프는 muted-foreground 톤을 쓴다", () => {
		for (const provider of PROVIDER_IDS) {
			const { container } = render(<ProviderGlyph provider={provider} />);
			const svg = container.querySelector("svg");
			if (svg) expect(svg.getAttribute("class") ?? "", provider).toContain("text-muted-foreground");
			cleanup();
		}
	});
});
