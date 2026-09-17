import { describe, expect, it } from "vitest";
import { mixHex } from "@/lib/editor/codeLangExtensions";
import {
	DARK_TERMINAL_PALETTE,
	LIGHT_TERMINAL_PALETTE,
} from "@/lib/theme/terminalTheme";

describe("editor chrome derivation", () => {
	it("기본 팔레트에서 크롬이 배경 바로 옆 한 단계로 앉는다", () => {
		const dark = DARK_TERMINAL_PALETTE;
		const light = LIGHT_TERMINAL_PALETTE;
		// 에디터 크롬은 에디터가 실제로 칠하는 배경(P.background)에서 파생한다.
		// 값을 배경과 무관하게 고정하면 활성 줄이 배경보다 어두워져 강조가
		// 뒤집힌다. 다크 배경은 시안의 glass/pane(#242424)이다 — 에디터도
		// 터미널과 같은 pane 면 위에 앉으므로 같은 값에서 파생한다(2026-09-02).
		expect(mixHex(dark.background, dark.foreground, 0.045)).toBe("#2d2d2d");
		expect(mixHex(dark.background, dark.foreground, 0.096)).toBe("#373737");
		expect(mixHex(light.background, light.foreground, 0.045)).toBe("#f5f5f5");
	});

	it("크롬은 배경에서 전경 쪽으로만, 아주 조금 움직인다", () => {
		// 위 앵커가 팔레트를 따라 바뀔 때 방향까지 같이 뒤집히지 않게 잡는다.
		for (const palette of [DARK_TERMINAL_PALETTE, LIGHT_TERMINAL_PALETTE]) {
			const level = (hex: string) => Number.parseInt(hex.slice(1, 3), 16);
			const bg = level(palette.background);
			const fg = level(palette.foreground);
			const active = level(
				mixHex(palette.background, palette.foreground, 0.045),
			);
			// 전경 쪽으로 움직였고(부호), 배경을 대체할 만큼은 아니다(크기).
			expect(Math.sign(active - bg)).toBe(Math.sign(fg - bg));
			expect(Math.abs(active - bg)).toBeLessThan(Math.abs(fg - bg) / 4);
		}
	});

	it("팔레트를 갈아끼우면 크롬도 그 색조를 따라간다", () => {
		// solarized-dark 스타일 배경 — 파생값이 청록 틴트를 유지해야 한다.
		const mixed = mixHex("#002b36", "#839496", 0.045);
		expect(mixed).not.toBe("#141414");
		const r = Number.parseInt(mixed.slice(1, 3), 16);
		const b = Number.parseInt(mixed.slice(5, 7), 16);
		expect(b).toBeGreaterThan(r);
	});
});
