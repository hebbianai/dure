import { describe, expect, it } from "vitest";

import { parseTerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocation";

describe("terminal execution location", () => {
	it("decodes an SSH target and an explicit return to local", () => {
		expect(
			parseTerminalExecutionLocation(
				"terminal-execution-v1;727473403231312e3138312e3132322e313234",
			),
		).toEqual({ kind: "ssh", target: "rts@211.181.122.124" });
		expect(parseTerminalExecutionLocation("terminal-execution-v1;")).toEqual({
			kind: "local",
		});
	});

	it("fails closed on malformed, oversized, or unsafe targets", () => {
		expect(parseTerminalExecutionLocation("other;727473")).toBeNull();
		expect(parseTerminalExecutionLocation("terminal-execution-v1;0")).toBeNull();
		expect(parseTerminalExecutionLocation("terminal-execution-v1;zz")).toBeNull();
		expect(
			parseTerminalExecutionLocation("terminal-execution-v1;7274730a686f7374"),
		).toBeNull();
		expect(
			parseTerminalExecutionLocation(
				`terminal-execution-v1;${"61".repeat(513)}`,
			),
		).toBeNull();
	});
});
