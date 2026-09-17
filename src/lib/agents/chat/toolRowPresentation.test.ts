import { describe, expect, it } from "vitest";
import { presentToolRow } from "@/lib/agents/chat/toolRowPresentation";

describe("presentToolRow", () => {
	it("summarizes Claude file tools by their shortened path", () => {
		expect(
			presentToolRow("Read", {
				file_path: "/Users/jwan/projects/app/src/lib/agents/chat/foo.ts",
			}),
		).toEqual({ label: "Read", detail: "…/agents/chat/foo.ts" });
		expect(presentToolRow("Edit", { file_path: "README.md" })).toEqual({
			label: "Edit",
			detail: "README.md",
		});
	});

	it("summarizes shell tools by their collapsed command", () => {
		expect(
			presentToolRow("Bash", { command: "pnpm verify \\\n  --frontend" }),
		).toEqual({ label: "Bash", detail: "pnpm verify \\ --frontend" });
		expect(
			presentToolRow("commandExecution", {
				command: ["pnpm", "gate:scope"],
				cwd: "/tmp",
			}),
		).toEqual({ label: "Shell", detail: "pnpm gate:scope" });
	});

	it("keeps only the tool segment of Claude MCP tool names", () => {
		expect(
			presentToolRow("mcp__plugin_playwright_playwright__browser_click", {
				element: "Send button",
			}),
		).toEqual({ label: "browser_click", detail: null });
		expect(presentToolRow("mcp__server__fetch", { url: "https://a.dev" })).toEqual(
			{ label: "fetch", detail: "https://a.dev" },
		);
	});

	it("maps codex item kinds to the shared verb register", () => {
		expect(presentToolRow("webSearch", { query: "tailwind v4 tokens" })).toEqual(
			{ label: "Search", detail: "tailwind v4 tokens" },
		);
		expect(presentToolRow("mcpToolCall", { tool: "browser_click" })).toEqual({
			label: "MCP",
			detail: "browser_click",
		});
	});

	it("summarizes codex file changes by path with an overflow count", () => {
		expect(
			presentToolRow("fileChange", {
				changes: [
					{ path: "/repo/crates/app/src/lib.rs", kind: "update" },
					{ path: "/repo/src/main.rs", kind: "update" },
				],
			}),
		).toEqual({ label: "Edit", detail: "…/app/src/lib.rs +1" });
	});

	it("truncates oversized details instead of flooding the row", () => {
		const { detail } = presentToolRow("Bash", { command: "x".repeat(500) });
		expect(detail?.length).toBeLessThanOrEqual(120);
		expect(detail?.endsWith("…")).toBe(true);
	});

	it("falls back to the bare tool name when nothing is extractable", () => {
		expect(presentToolRow("TodoWrite", { todos: [] })).toEqual({
			label: "TodoWrite",
			detail: null,
		});
		expect(presentToolRow("Read", null)).toEqual({
			label: "Read",
			detail: null,
		});
		expect(presentToolRow("Read", "raw")).toEqual({
			label: "Read",
			detail: null,
		});
	});
});
