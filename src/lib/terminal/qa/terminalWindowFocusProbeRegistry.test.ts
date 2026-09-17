import { describe, expect, test, vi } from "vitest";
import type { TerminalWindowFocusProbe } from "@/lib/terminal/terminalWindowFocusProbe";
import {
	registerTerminalWindowFocusProbe,
	terminalWindowFocusProbeForSurface,
} from "./terminalWindowFocusProbeRegistry";

function probe(): TerminalWindowFocusProbe {
	return {
		connect: vi.fn(() => vi.fn()),
		onHydrationChange: vi.fn(),
		onSynchronized: vi.fn(),
		onPresented: vi.fn(),
		onError: vi.fn(),
	};
}

describe("terminalWindowFocusProbeRegistry", () => {
	test("publishes exact pane probes and replacement-safe cleanup", () => {
		const first = probe();
		const sibling = probe();
		const releaseFirst = registerTerminalWindowFocusProbe("term:first", first);
		const releaseSibling = registerTerminalWindowFocusProbe(
			"term:sibling",
			sibling,
		);

		expect(terminalWindowFocusProbeForSurface("term:first")).toBe(first);
		expect(terminalWindowFocusProbeForSurface("term:sibling")).toBe(sibling);
		expect(() =>
			registerTerminalWindowFocusProbe("term:first", probe()),
		).toThrow("terminal window focus probe is already registered: term:first");

		releaseFirst();
		expect(terminalWindowFocusProbeForSurface("term:first")).toBeUndefined();
		expect(terminalWindowFocusProbeForSurface("term:sibling")).toBe(sibling);
		releaseFirst();
		releaseSibling();
	});
});
