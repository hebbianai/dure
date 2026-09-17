import { describe, expect, it } from "vitest";
import {
	RECENT_FILE_OPENS_CAP,
	normalizeRecentFileOpens,
	pushRecentFileOpen,
} from "@/lib/files/recentFileOpens";

const entry = (path: string, at: number) => ({
	path,
	source: "local" as const,
	at,
});

describe("pushRecentFileOpen", () => {
	it("같은 파일은 맨 앞으로 끌어올린다 (중복 없음)", () => {
		const list = pushRecentFileOpen(
			[entry("/a", 1), entry("/b", 2)],
			entry("/b", 3),
		);
		expect(list.map((e) => e.path)).toEqual(["/b", "/a"]);
	});

	it("host가 다르면 다른 파일이다", () => {
		const remote = { path: "/a", source: "ssh" as const, hostId: "h1", at: 2 };
		const list = pushRecentFileOpen([entry("/a", 1)], remote);
		expect(list).toHaveLength(2);
	});

	it("상한을 넘으면 오래된 것부터 버린다", () => {
		let list: ReturnType<typeof pushRecentFileOpen> = [
			...Array(RECENT_FILE_OPENS_CAP),
		].map((_, i) => entry(`/f${i}`, i));
		list = pushRecentFileOpen(list, entry("/new", 999));
		expect(list).toHaveLength(RECENT_FILE_OPENS_CAP);
		expect(list[0].path).toBe("/new");
	});
});

describe("normalizeRecentFileOpens", () => {
	it("손상 레코드는 조용히 버린다", () => {
		expect(
			normalizeRecentFileOpens([
				entry("/ok", 1),
				{ path: "", source: "local", at: 2 },
				{ path: "/bad-source", source: "ftp", at: 3 },
				{ path: "/bad-at", source: "local", at: "x" },
				null,
				"junk",
			]),
		).toEqual([entry("/ok", 1)]);
		expect(normalizeRecentFileOpens("not-array")).toEqual([]);
	});
});
