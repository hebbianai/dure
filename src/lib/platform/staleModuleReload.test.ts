import { describe, expect, it, vi } from "vitest";
import {
	autoReloadForStaleModule,
	isStaleModuleError,
	STALE_RELOAD_COOLDOWN_MS,
	shouldAutoReload,
} from "./staleModuleReload";

function memoryStorage(initial: Record<string, string> = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
	};
}

describe("isStaleModuleError", () => {
	it("스테일 lazy 청크 실패 문구를 플랫폼별로 인식한다", () => {
		expect(isStaleModuleError("Importing a module script failed.")).toBe(true);
		expect(
			isStaleModuleError("Failed to fetch dynamically imported module: http://x/chunk.js"),
		).toBe(true);
		expect(isStaleModuleError("error loading dynamically imported module")).toBe(true);
		expect(isStaleModuleError("Unable to preload CSS for /assets/x.css")).toBe(true);
		expect(isStaleModuleError("TypeError: undefined is not a function")).toBe(false);
	});
});

describe("shouldAutoReload", () => {
	it("쿨다운 안의 재발은 리로드하지 않는다 — 새로고침 루프 방지", () => {
		expect(shouldAutoReload(1_000, null)).toBe(true);
		expect(shouldAutoReload(1_000 + STALE_RELOAD_COOLDOWN_MS - 1, 1_000)).toBe(false);
		expect(shouldAutoReload(1_000 + STALE_RELOAD_COOLDOWN_MS, 1_000)).toBe(true);
	});
});

describe("autoReloadForStaleModule", () => {
	it("스테일 오류면 1회 리로드하고 시각을 기록한다", () => {
		const reload = vi.fn();
		const storage = memoryStorage();
		expect(
			autoReloadForStaleModule(
				{ message: "Importing a module script failed." },
				{ storage, reload, nowMs: 5_000 },
			),
		).toBe(true);
		expect(reload).toHaveBeenCalledOnce();
		// 쿨다운 안의 두 번째 스테일 오류는 리로드하지 않는다.
		expect(
			autoReloadForStaleModule(
				{ message: "Importing a module script failed." },
				{ storage, reload, nowMs: 6_000 },
			),
		).toBe(false);
		expect(reload).toHaveBeenCalledOnce();
	});

	it("무관한 오류·storage 고장은 각각 무시·무해하다", () => {
		const reload = vi.fn();
		expect(
			autoReloadForStaleModule({ message: "boom" }, { reload, nowMs: 1 }),
		).toBe(false);
		expect(reload).not.toHaveBeenCalled();
		const broken = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		};
		expect(
			autoReloadForStaleModule(
				{ message: "Importing a module script failed." },
				{ storage: broken, reload, nowMs: 1 },
			),
		).toBe(true);
		expect(reload).toHaveBeenCalledOnce();
	});
});
