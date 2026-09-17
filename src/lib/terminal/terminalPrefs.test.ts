import { describe, expect, it } from "vitest";
import {
	DEFAULT_TERMINAL_PREFS,
	normalizeTerminalPrefs,
} from "./terminalPrefs";

describe("normalizeTerminalPrefs", () => {
	it("keeps supported booleans and drops retired renderer fields", () => {
		expect(
			normalizeTerminalPrefs({
				copyOnSelect: false,
				osc52: false,
				gpu: "on",
				scrollbackLines: 50_000,
			}),
		).toEqual({ copyOnSelect: false, osc52: false });
	});

	it("defaults invalid persisted values", () => {
		expect(normalizeTerminalPrefs({ copyOnSelect: "yes", osc52: 1 })).toEqual(
			DEFAULT_TERMINAL_PREFS,
		);
		expect(normalizeTerminalPrefs(null)).toEqual(DEFAULT_TERMINAL_PREFS);
		expect(normalizeTerminalPrefs([])).toEqual(DEFAULT_TERMINAL_PREFS);
	});
});
