// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteSshHostUsed, readRecentSshHostId } from "@/lib/ssh/recentSshHost";

afterEach(() => {
	window.localStorage.clear();
	vi.restoreAllMocks();
});

describe("recentSshHost", () => {
	it("기록이 없으면 undefined", () => {
		expect(readRecentSshHostId()).toBeUndefined();
	});

	it("마지막으로 쓴 호스트 하나만 남는다", () => {
		noteSshHostUsed("host-a");
		noteSshHostUsed("host-b");
		expect(readRecentSshHostId()).toBe("host-b");
	});

	it("빈 hostId는 기록을 덮어쓰지 않는다", () => {
		noteSshHostUsed("host-a");
		noteSshHostUsed("");
		expect(readRecentSshHostId()).toBe("host-a");
	});

	it("localStorage가 던져도 분할 흐름을 막지 않는다", () => {
		// private 모드·용량 초과는 접근자 자체가 던진다 — 메서드 스텁으로는
		// 재현되지 않아 저장소를 통째로 갈아 끼운다.
		const real = Object.getOwnPropertyDescriptor(window, "localStorage");
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			get() {
				throw new Error("SecurityError");
			},
		});
		try {
			expect(() => noteSshHostUsed("host-a")).not.toThrow();
			expect(readRecentSshHostId()).toBeUndefined();
		} finally {
			if (real) Object.defineProperty(window, "localStorage", real);
		}
	});
});
