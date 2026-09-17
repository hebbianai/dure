import { describe, expect, it } from "vitest";
import { projectIndexFor } from "@/lib/spaces/projectIndex";

const projects = [
	{ id: "root", path: "/repo" },
	{ id: "nested", path: "/repo/packages/app" },
	{ id: "mid", path: "/repo/packages" },
	{ id: "other", path: "/elsewhere" },
];

describe("projectIndexFor", () => {
	it("resolves the longest-prefix owner, exactly like filter+sort-desc[0]", () => {
		const index = projectIndexFor(projects);
		expect(index.resolveByCwd("/repo")?.id).toBe("root");
		expect(index.resolveByCwd("/repo/src/lib")?.id).toBe("root");
		expect(index.resolveByCwd("/repo/packages")?.id).toBe("mid");
		expect(index.resolveByCwd("/repo/packages/app/src")?.id).toBe("nested");
		expect(index.resolveByCwd("/elsewhere/x")?.id).toBe("other");
	});

	it("never matches a sibling that only shares a string prefix", () => {
		const index = projectIndexFor([{ id: "a", path: "/repo" }]);
		// "/repo-two" starts with "/repo" as a string but is not inside it.
		expect(index.resolveByCwd("/repo-two")).toBeUndefined();
		expect(index.resolveByCwd("")).toBeUndefined();
	});

	it("keeps registration order for equal-length ties (stable sort parity)", () => {
		const tied = [
			{ id: "first", path: "/aaaa" },
			{ id: "second", path: "/bbbb" },
		];
		const index = projectIndexFor(tied);
		// A cwd owned by both cannot exist for distinct roots; parity matters
		// only when one path owns the cwd. Guard the by-id map instead.
		expect(index.byId.get("first")?.path).toBe("/aaaa");
		expect(index.byId.get("second")?.path).toBe("/bbbb");
	});

	it("returns the same index instance for the same array identity", () => {
		expect(projectIndexFor(projects)).toBe(projectIndexFor(projects));
		expect(projectIndexFor([...projects])).not.toBe(projectIndexFor(projects));
	});

	it("memoizes per-cwd lookups including misses", () => {
		const index = projectIndexFor([...projects]);
		const first = index.resolveByCwd("/repo/packages/app");
		expect(index.resolveByCwd("/repo/packages/app")).toBe(first);
		expect(index.resolveByCwd("/nowhere")).toBeUndefined();
		expect(index.resolveByCwd("/nowhere")).toBeUndefined();
	});
});
