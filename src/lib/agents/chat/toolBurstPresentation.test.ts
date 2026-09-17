import { describe, expect, it } from "vitest";
import { summarizeToolBurst } from "@/lib/agents/chat/toolBurstPresentation";

describe("summarizeToolBurst", () => {
	it("counts calls per category in a stable order", () => {
		expect(
			summarizeToolBurst([
				{ name: "Bash", state: "completed" },
				{ name: "Read", state: "completed" },
				{ name: "Read", state: "completed" },
				{ name: "Edit", state: "completed" },
				{ name: "commandExecution", state: "completed" },
			]),
		).toEqual({
			parts: [
				{ category: "read", count: 2 },
				{ category: "edit", count: 1 },
				{ category: "run", count: 2 },
			],
			failed: 0,
			running: false,
		});
	});

	it("maps searches and unknown tools without dropping any call", () => {
		const summary = summarizeToolBurst([
			{ name: "Grep", state: "completed" },
			{ name: "webSearch", state: "completed" },
			{ name: "TodoWrite", state: "completed" },
			{ name: "mcp__server__browser_click", state: "completed" },
		]);
		expect(summary.parts).toEqual([
			{ category: "search", count: 2 },
			{ category: "other", count: 2 },
		]);
	});

	it("counts distinct files, not repeated calls on the same file", () => {
		expect(
			summarizeToolBurst([
				{ name: "Edit", state: "completed", input: { file_path: "src/a.ts" } },
				{ name: "Edit", state: "completed", input: { file_path: "src/a.ts" } },
				{ name: "Edit", state: "completed", input: { file_path: "src/b.ts" } },
				{ name: "Read", state: "completed", input: { file_path: "src/a.ts" } },
				{ name: "Read", state: "completed", input: { file_path: "src/a.ts" } },
			]).parts,
		).toEqual([
			{ category: "read", count: 1 },
			{ category: "edit", count: 2 },
		]);
	});

	it("reports failures and liveness", () => {
		const summary = summarizeToolBurst([
			{ name: "Bash", state: "failed" },
			{ name: "Read", state: "running" },
		]);
		expect(summary.failed).toBe(1);
		expect(summary.running).toBe(true);
	});
});
