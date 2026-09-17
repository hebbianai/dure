import { describe, expect, it } from "vitest";
import { presentToolDetail } from "@/lib/agents/chat/toolDetailPresentation";

describe("presentToolDetail", () => {
	it("presents shell calls with their extracted text output", () => {
		expect(
			presentToolDetail("Bash", { command: "pnpm gate:scope" }, "frontend\n"),
		).toEqual({
			kind: "shell",
			command: "pnpm gate:scope",
			output: "frontend\n",
		});
		expect(
			presentToolDetail(
				"commandExecution",
				{ command: ["pnpm", "verify"] },
				{ exitCode: 0, aggregatedOutput: "done" },
			),
		).toEqual({ kind: "shell", command: "pnpm verify", output: "done" });
	});

	it("counts a Claude edit by what changed, not by the size of the quoted block", () => {
		const detail = presentToolDetail(
			"Edit",
			{
				file_path: "src/a.ts",
				old_string: "one\ntwo\nthree",
				new_string: "one\ntwo",
			},
			null,
		);
		expect(detail).toMatchObject({
			kind: "file",
			path: "src/a.ts",
			added: 0,
			removed: 1,
		});
		expect(detail.kind === "file" && detail.files[0]?.diff.lines).toEqual([
			{ kind: "context", text: "one" },
			{ kind: "context", text: "two" },
			{ kind: "removed", text: "three" },
		]);
	});

	it("shows a write as added lines and never claims what it displaced", () => {
		const detail = presentToolDetail(
			"Write",
			{ file_path: "b.md", content: "x\ny" },
			null,
		);
		expect(detail).toMatchObject({
			kind: "file",
			path: "b.md",
			added: 2,
			removed: null,
		});
		expect(detail.kind === "file" && detail.files[0]?.diff.lines).toEqual([
			{ kind: "added", text: "x" },
			{ kind: "added", text: "y" },
		]);
	});

	it("reads every file of a codex patch from its own unified diff", () => {
		const detail = presentToolDetail(
			"fileChange",
			{
				changes: [
					{
						path: "/r/a.rs",
						kind: "update",
						diff: "@@ -1,2 +1,2 @@\n-old\n+new\n ok",
					},
					{
						path: "/r/b.rs",
						kind: "update",
						diff: "@@ -1 +1,2 @@\n ok\n+extra",
					},
				],
			},
			null,
		);
		// Several files changed: the header keeps no single path, and the
		// diffstat totals the patch.
		expect(detail).toMatchObject({
			kind: "file",
			path: null,
			added: 2,
			removed: 1,
		});
		expect(
			detail.kind === "file" && detail.files.map((file) => file.path),
		).toEqual(["/r/a.rs", "/r/b.rs"]);
	});

	it("keeps a change it cannot read, and opaque payloads, honest", () => {
		expect(
			presentToolDetail("fileChange", { changes: [{ path: "/r/a.rs" }] }, null),
		).toEqual({
			kind: "file",
			path: null,
			added: null,
			removed: null,
			files: [],
		});
		expect(presentToolDetail("Bash", { restart: true }, null)).toEqual({
			kind: "json",
		});
		expect(presentToolDetail("mcp__s__tool", { x: 1 }, null)).toEqual({
			kind: "json",
		});
	});
});
