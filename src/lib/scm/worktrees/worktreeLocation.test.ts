import { describe, expect, it } from "vitest";
import {
	compareWorktreeLocations,
	sameWorktreeLocation,
} from "@/lib/scm/worktrees/worktreeLocation";

describe("sameWorktreeLocation", () => {
	it("accepts equivalent ordinary Windows spellings", () => {
		expect(sameWorktreeLocation("C:\\Repo\\wt", "c:/repo/wt/", "native")).toBe(
			true,
		);
		expect(
			sameWorktreeLocation(
				"\\\\Server\\Share\\Repo\\wt",
				"//server/share/repo/wt/",
				"native",
			),
		).toBe(true);
	});

	it("keeps POSIX spelling exact and leaves aliases to the Host", () => {
		expect(sameWorktreeLocation("/Repo/wt", "/repo/wt", "posix")).toBe(false);
		expect(sameWorktreeLocation("/repo/link", "/repo/real", "posix")).toBe(
			false,
		);
		expect(compareWorktreeLocations("/repo/./wt", "/repo/wt", "posix")).toBe(
			"unresolved",
		);
		expect(
			compareWorktreeLocations("//server/share", "/server/share", "posix"),
		).toBe("unresolved");
	});

	it("does not reinterpret Windows device or dot paths", () => {
		for (const path of [
			"\\\\?\\C:\\Repo\\wt",
			"//?/C:/Repo/wt",
			"\\\\.\\C:\\Repo\\wt",
			"C:\\Repo\\.\\wt",
		]) {
			expect(compareWorktreeLocations(path, "C:\\Repo\\wt", "native")).toBe(
				"unresolved",
			);
		}
		expect(
			compareWorktreeLocations(
				"\\\\?\\C:\\Repo\\wt",
				"\\\\?\\C:\\Repo\\wt",
				"native",
			),
		).toBe("same");
	});

	it("preserves filesystem roots while trimming trailing separators", () => {
		expect(sameWorktreeLocation("/", "", "posix")).toBe(false);
		expect(sameWorktreeLocation("C:\\", "c:/", "native")).toBe(true);
	});
});
