// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectTerminalGeometryDiagnostics } from "./terminalGeometryDiagnostics";

describe("terminal geometry diagnostics", () => {
	it("counts the current renderer representation without collecting terminal text", () => {
		const doc = document.implementation.createHTMLDocument();
		doc.body.innerHTML = `
			<span data-terminal-run data-terminal-cell>outside any surface</span>
			<div class="structured-terminal-host">
				<div data-terminal-surface-id="surface-a">
					<div class="term-row">
						<span data-terminal-run>private terminal text</span>
						<span data-terminal-run data-terminal-cell>한</span>
					</div>
					<div class="term-row"><a data-terminal-run>linked run</a></div>
					<div class="terminal-viewport-cursor"><span>cursor</span></div>
				</div>
			</div>
			<div class="structured-terminal-host">
				<div data-terminal-surface-id="surface-b">
					<div class="term-row"><span data-terminal-run data-terminal-cell>b</span></div>
				</div>
			</div>
		`;
		const markup = doc.body.innerHTML;
		const before = collectTerminalGeometryDiagnostics(doc);
		expect(before.surfaces).toMatchObject([
			{
				surfaceId: "surface-a",
				renderedRows: 2,
				renderedRuns: 3,
				positionedRuns: 1,
			},
			{
				surfaceId: "surface-b",
				renderedRows: 1,
				renderedRuns: 1,
				positionedRuns: 1,
			},
		]);
		expect(doc.body.innerHTML).toBe(markup);
		expect(JSON.stringify(before)).not.toContain("private terminal text");

		const run = doc.createElement("span");
		run.dataset.terminalRun = "";
		run.dataset.terminalCell = "";
		doc.querySelector(".term-row")?.append(run);
		expect(collectTerminalGeometryDiagnostics(doc).surfaces[0]).toMatchObject({
			renderedRuns: 4,
			positionedRuns: 2,
		});
		expect(before.surfaces[0]).toMatchObject({
			renderedRuns: 3,
			positionedRuns: 1,
		});

		doc.querySelector(".structured-terminal-host")?.remove();
		expect(collectTerminalGeometryDiagnostics(doc).surfaces).toMatchObject([
			{ surfaceId: "surface-b", renderedRuns: 1, positionedRuns: 1 },
		]);
	});

	it("reports an empty mounted surface and omits presentations without a host", () => {
		const doc = document.implementation.createHTMLDocument();
		doc.body.innerHTML = `
			<div data-terminal-surface-id="unowned"><span data-terminal-run></span></div>
			<div class="structured-terminal-host"><div data-terminal-surface-id="empty"></div></div>
		`;
		expect(collectTerminalGeometryDiagnostics(doc).surfaces).toMatchObject([
			{
				surfaceId: "empty",
				renderedRows: 0,
				renderedRuns: 0,
				positionedRuns: 0,
			},
		]);
	});
});
