import { expect, it } from "vitest";
import { sameTerminalEnvironment } from "@/lib/terminal/terminalEnvironmentEquality";

it("treats an absent environment as empty", () => {
	expect(sameTerminalEnvironment(undefined, {})).toBe(true);
	expect(sameTerminalEnvironment(undefined, { TERM: "xterm" })).toBe(false);
});

it("matches only when every key on either side agrees", () => {
	expect(
		sameTerminalEnvironment(
			{ TERM: "xterm", NO_COLOR: null },
			{ TERM: "xterm", NO_COLOR: null },
		),
	).toBe(true);
	expect(
		sameTerminalEnvironment({ TERM: "xterm" }, { TERM: "xterm-256color" }),
	).toBe(false);
	expect(sameTerminalEnvironment({ TERM: "xterm" }, {})).toBe(false);
});

it("distinguishes an explicit null from an absent variable", () => {
	expect(sameTerminalEnvironment({ NO_COLOR: null }, {})).toBe(false);
	expect(sameTerminalEnvironment({}, { NO_COLOR: null })).toBe(false);
});
