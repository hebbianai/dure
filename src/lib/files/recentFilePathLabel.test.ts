import { describe, expect, it } from "vitest";
import { recentFileLabel } from "@/lib/files/recentFilePathLabel";

describe("recentFileLabel", () => {
	it("splits a path into the file name and its containing directory", () => {
		expect(recentFileLabel("/a/hebbian-agents/src/main/ipc/bus.ts")).toEqual({
			name: "bus.ts",
			directory: "…/src/main/ipc",
		});
	});

	it("keeps a short directory whole", () => {
		expect(recentFileLabel("/src/store.ts").directory).toBe("src");
		expect(recentFileLabel("a/b/c/file.ts").directory).toBe("a/b/c");
	});

	/** 꼬리를 남기는 것이 이 함수의 목적이다 — 머리만 남기면 같은 저장소의
	 *  파일들이 전부 같은 라벨로 보인다. */
	it("drops leading segments rather than trailing ones", () => {
		const { directory } = recentFileLabel(
			"/Users/me/Documents/Develop/agent-ide/src/components/spaces/Row.tsx",
		);
		expect(directory).toBe("…/src/components/spaces");
		expect(directory.endsWith("spaces")).toBe(true);
	});

	it("returns an empty directory for a bare file name", () => {
		expect(recentFileLabel("store.ts")).toEqual({ name: "store.ts", directory: "" });
		expect(recentFileLabel("/store.ts")).toEqual({ name: "store.ts", directory: "" });
	});

	/** 폭에서 예산을 계산하는 호출자가 0으로 수렴하면 "가장 짧게"여야지
	 *  "제한 없음"이면 안 된다. */
	it("treats a zero or negative budget as no directory at all", () => {
		expect(recentFileLabel("a/b/c/d/file.ts", 0).directory).toBe("");
		expect(recentFileLabel("a/b/c/d/file.ts", -1).directory).toBe("");
		expect(recentFileLabel("a/b/c/d/file.ts", 1).directory).toBe("…/d");
	});

	/** 두 값이 한 번의 분해에서 나오므로 빈 마디에서 서로 어긋나지 않는다. */
	it("agrees on name and directory for paths with empty segments", () => {
		expect(recentFileLabel("/a//b/file.ts")).toEqual({
			name: "file.ts",
			directory: "a/b",
		});
		expect(recentFileLabel("/a/b/")).toEqual({ name: "b", directory: "a" });
	});
});
