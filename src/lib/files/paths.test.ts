import { describe, expect, it } from "vitest";
import {
	normalizeSlashPath,
	pathBasename,
	pathParentName,
	trimTrailingSlash,
} from "./paths";

describe("pathBasename", () => {
	it("trailing slash·빈 세그먼트를 무시하고 마지막 이름을 돌려준다", () => {
		expect(pathBasename("/a/b/c")).toBe("c");
		expect(pathBasename("/a/b/c///")).toBe("c");
		expect(pathBasename("worktree")).toBe("worktree");
	});

	it("세그먼트가 없으면 fallback(기본: 원본)이다", () => {
		expect(pathBasename("///")).toBe("///");
		expect(pathBasename("///", "")).toBe("");
		expect(pathBasename("", "unknown")).toBe("unknown");
	});
});

describe("normalizeSlashPath", () => {
	it("백슬래시 통일 + trailing 제거, 루트는 '/'로 남는다", () => {
		expect(normalizeSlashPath("C:\\repo\\dure\\")).toBe("C:/repo/dure");
		expect(normalizeSlashPath("/a/b///")).toBe("/a/b");
		expect(normalizeSlashPath("/")).toBe("/");
		expect(normalizeSlashPath("")).toBe("/");
	});
});

describe("trimTrailingSlash", () => {
	it("trim 후 trailing 제거하되 '/'는 보존한다 — cwd 소유 판정 계약", () => {
		expect(trimTrailingSlash("  /a/b/ ")).toBe("/a/b");
		expect(trimTrailingSlash("/")).toBe("/");
		expect(trimTrailingSlash("/a")).toBe("/a");
	});
});

describe("pathParentName", () => {
	it("names the folder above the last segment, ignoring a trailing slash", () => {
		expect(pathParentName("/work/dure/src")).toBe("dure");
		expect(pathParentName("/work/dure/src/")).toBe("dure");
	});

	it("is empty when there is no parent segment", () => {
		expect(pathParentName("/dure")).toBe("");
		expect(pathParentName("dure")).toBe("");
		expect(pathParentName("")).toBe("");
	});
});
