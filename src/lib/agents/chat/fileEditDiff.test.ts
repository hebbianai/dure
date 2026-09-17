import { describe, expect, it } from "vitest";
import {
	addedFileRows,
	editDiffRows,
	unifiedDiffRows,
} from "@/lib/agents/chat/fileEditDiff";

describe("editDiffRows", () => {
	it("keeps the changed lines with their surrounding context", () => {
		const diff = editDiffRows("a\nb\nc\nd", "a\nB\nc\nd");
		expect(diff).toEqual({
			lines: [
				{ kind: "context", text: "a" },
				{ kind: "removed", text: "b" },
				{ kind: "added", text: "B" },
				{ kind: "context", text: "c" },
				{ kind: "context", text: "d" },
			],
			added: 1,
			removed: 1,
			hiddenLines: 0,
		});
	});

	it("counts only what actually changed inside a large unchanged block", () => {
		const before = Array.from({ length: 40 }, (_, index) => `line ${index}`);
		const after = [...before];
		after[20] = "line 20 changed";
		const diff = editDiffRows(before.join("\n"), after.join("\n"));
		expect(diff?.added).toBe(1);
		expect(diff?.removed).toBe(1);
		// Three lines of context on each side, the rest collapsed into gaps.
		expect(diff?.lines).toEqual([
			{ kind: "gap", hiddenLines: 17 },
			{ kind: "context", text: "line 17" },
			{ kind: "context", text: "line 18" },
			{ kind: "context", text: "line 19" },
			{ kind: "removed", text: "line 20" },
			{ kind: "added", text: "line 20 changed" },
			{ kind: "context", text: "line 21" },
			{ kind: "context", text: "line 22" },
			{ kind: "context", text: "line 23" },
			{ kind: "gap", hiddenLines: 16 },
		]);
	});

	it("is nothing when the two sides are identical", () => {
		expect(editDiffRows("same\n", "same\n")).toBeNull();
	});

	it("bounds a diff nobody can read and says how much it dropped", () => {
		const before = Array.from({ length: 300 }, (_, index) => `old ${index}`);
		const after = Array.from({ length: 300 }, (_, index) => `new ${index}`);
		const diff = editDiffRows(before.join("\n"), after.join("\n"));
		expect(diff?.added).toBe(300);
		expect(diff?.removed).toBe(300);
		expect(diff?.lines).toHaveLength(160);
		expect(diff?.hiddenLines).toBe(440);
	});
});

describe("unifiedDiffRows", () => {
	it("reads a provider patch as rows and drops its file headers", () => {
		const diff = unifiedDiffRows(
			[
				"diff --git a/src/a.rs b/src/a.rs",
				"--- a/src/a.rs",
				"+++ b/src/a.rs",
				"@@ -1,3 +1,3 @@",
				" fn main() {",
				"-    old();",
				"+    new();",
				" }",
			].join("\n"),
		);
		expect(diff).toEqual({
			lines: [
				{ kind: "hunk", text: "@@ -1,3 +1,3 @@" },
				{ kind: "context", text: "fn main() {" },
				{ kind: "removed", text: "    old();" },
				{ kind: "added", text: "    new();" },
				{ kind: "context", text: "}" },
			],
			added: 1,
			removed: 1,
			hiddenLines: 0,
		});
	});

	it("is nothing when the patch carries no change", () => {
		expect(unifiedDiffRows("@@ -1 +1 @@\n unchanged")).toBeNull();
	});
});

describe("addedFileRows", () => {
	it("presents a new file as added lines", () => {
		expect(addedFileRows("one\ntwo\n")).toEqual({
			lines: [
				{ kind: "added", text: "one" },
				{ kind: "added", text: "two" },
			],
			added: 2,
			removed: 0,
			hiddenLines: 0,
		});
		expect(addedFileRows("")).toBeNull();
	});
});
