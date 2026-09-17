import { describe, expect, it, vi } from "vitest";
import { TerminalBoxCache } from "./terminalBoxCache";

function entry(overrides: Partial<ResizeObserverEntry>): ResizeObserverEntry {
	return overrides as ResizeObserverEntry;
}

describe("terminal box cache", () => {
	it("첫 RO 전달 전에는 매번 라이브로 읽는다 — 마운트 전이(0×0→실크기) 추적", () => {
		const live = vi
			.fn()
			.mockReturnValueOnce({ width: 0, height: 0 })
			.mockReturnValueOnce({ width: 640, height: 480 });
		const cache = new TerminalBoxCache(live);
		expect(cache.read()).toEqual({ width: 0, height: 0 });
		expect(cache.read()).toEqual({ width: 640, height: 480 });
		expect(live).toHaveBeenCalledTimes(2);
	});

	it("RO 전달 후에는 라이브 읽기가 없다 — 강제 레이아웃 제거의 핵심 계약", () => {
		const live = vi.fn().mockReturnValue({ width: 1, height: 1 });
		const cache = new TerminalBoxCache(live);
		expect(
			cache.updateFromEntry(
				entry({
					borderBoxSize: [
						{ inlineSize: 800, blockSize: 600 },
					] as unknown as ResizeObserverEntry["borderBoxSize"],
				}),
			),
		).toBe(true);
		expect(cache.read()).toEqual({ width: 800, height: 600 });
		expect(cache.read()).toEqual({ width: 800, height: 600 });
		expect(live).not.toHaveBeenCalled();
		// 다음 RO 전달이 크기를 갱신한다.
		expect(
			cache.updateFromEntry(
				entry({
					borderBoxSize: [
						{ inlineSize: 400, blockSize: 300 },
					] as unknown as ResizeObserverEntry["borderBoxSize"],
				}),
			),
		).toBe(true);
		expect(
			cache.updateFromEntry(
				entry({
					borderBoxSize: [
						{ inlineSize: 400, blockSize: 300 },
					] as unknown as ResizeObserverEntry["borderBoxSize"],
				}),
			),
		).toBe(false);
		expect(cache.read()).toEqual({ width: 400, height: 300 });
	});

	it("borderBoxSize가 없는 구형 전달은 contentRect로 폴백한다", () => {
		const cache = new TerminalBoxCache(() => ({ width: 0, height: 0 }));
		cache.updateFromEntry(
			entry({
				contentRect: { width: 320, height: 240 } as DOMRectReadOnly,
			}),
		);
		expect(cache.read()).toEqual({ width: 320, height: 240 });
	});

	it("rectFacade는 fit 게이트의 element 계약을 만족한다", () => {
		const cache = new TerminalBoxCache(() => ({ width: 100, height: 50 }));
		expect(cache.rectFacade.getBoundingClientRect()).toEqual({
			width: 100,
			height: 50,
		});
	});

	it("delivered exposes only the RO box and never forces a live read", () => {
		const live = vi.fn().mockReturnValue({ width: 640, height: 480 });
		const cache = new TerminalBoxCache(live);
		expect(cache.delivered()).toBeNull();
		cache.updateFromEntry(
			entry({
				borderBoxSize: [
					{ inlineSize: 0, blockSize: 0 },
				] as unknown as ResizeObserverEntry["borderBoxSize"],
			}),
		);
		expect(cache.delivered()).toEqual({ width: 0, height: 0 });
		expect(live).not.toHaveBeenCalled();
	});
});
