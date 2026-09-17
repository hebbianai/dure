// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { cloneTerminalPresentationSnapshot } from "./terminalPresentationSnapshot";

describe("cloneTerminalPresentationSnapshot", () => {
	it("keeps painted rows without cloning live-surface authority", () => {
		const host = document.createElement("div");
		host.innerHTML = `
			<div
				data-testid="structured-terminal-presentation"
				data-terminal-surface-id="surface-a"
				data-terminal-canonical-columns="80"
				data-terminal-viewport-rows="24"
				data-terminal-cell-width="8"
				data-terminal-row-height="16"
			>
				<div data-testid="structured-terminal-viewport">
					<div class="terminal-viewport-row">
						<span data-terminal-run>painted frame</span>
						<span class="terminal-viewport-blink">cursor</span>
					</div>
				</div>
				<textarea aria-label="Terminal input"></textarea>
			</div>
		`;

		const snapshot = cloneTerminalPresentationSnapshot(host);

		expect(snapshot).not.toBeNull();
		expect(snapshot?.textContent).toContain("painted frame");
		expect(snapshot?.dataset.terminalPresentationSnapshot).toBe("");
		expect(snapshot?.getAttribute("aria-hidden")).toBe("true");
		expect(snapshot?.querySelector("[data-terminal-run]")).not.toBeNull();
		expect(snapshot?.querySelector("[data-testid]")).toBeNull();
		expect(snapshot?.querySelector("[data-terminal-surface-id]")).toBeNull();
		expect(snapshot?.querySelector("textarea")).toBeNull();
		expect(snapshot?.querySelector(".terminal-viewport-blink")).toBeNull();
		expect(host.querySelector(".terminal-viewport-blink")).not.toBeNull();
	});

	it("returns null before a structured presentation has painted", () => {
		const host = document.createElement("div");
		expect(cloneTerminalPresentationSnapshot(host)).toBeNull();
	});
});
