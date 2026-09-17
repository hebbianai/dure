// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import { handleCliPerformanceReport } from "./cliPerformanceReport";

describe("CLI performance report", () => {
	it("collects a terminal-input projection without entering rich diagnostics", async () => {
		const claim = vi.fn().mockResolvedValue(true);
		const collectRich = vi.fn(() => {
			throw new Error("rich diagnostics must stay cold");
		});
		const terminalInputReport = {
			schemaVersion: 1,
			projection: "terminal-input",
			complete: true,
			expectedWindowLabels: ["main"],
			missingWindowLabels: [],
			windows: [],
		};
		const collectTerminalInput = vi.fn().mockResolvedValue(terminalInputReport);
		const handle = handleCliPerformanceReport as unknown as (
			requestId: string,
			params: Record<string, unknown>,
			claimRequest: (requestId: string) => Promise<boolean>,
			collectFullReport: () => Promise<unknown>,
			collectTerminalInputReport: () => Promise<unknown>,
		) => Promise<unknown>;

		await expect(
			handle(
				"request-terminal-input",
				{ projection: "terminal-input" },
				claim,
				collectRich,
				collectTerminalInput,
			),
		).resolves.toMatchObject({
			ok: true,
			projection: "terminal-input",
			report: terminalInputReport,
		});
		expect(claim).toHaveBeenCalledOnce();
		expect(collectTerminalInput).toHaveBeenCalledOnce();
		expect(collectRich).not.toHaveBeenCalled();
	});

	it("rejects an unknown projection before entering either collector", async () => {
		const collectRich = vi.fn();
		const collectTerminalInput = vi.fn();
		const handle = handleCliPerformanceReport as unknown as (
			requestId: string,
			params: Record<string, unknown>,
			claimRequest: (requestId: string) => Promise<boolean>,
			collectFullReport: () => Promise<unknown>,
			collectTerminalInputReport: () => Promise<unknown>,
		) => Promise<unknown>;

		await expect(
			handle(
				"request-invalid-projection",
				{ projection: "everything" },
				vi.fn().mockResolvedValue(true),
				collectRich,
				collectTerminalInput,
			),
		).resolves.toMatchObject({
			error: { code: "perf_report_projection_invalid" },
			ok: false,
		});
		expect(collectRich).not.toHaveBeenCalled();
		expect(collectTerminalInput).not.toHaveBeenCalled();
	});

	it("projects content-free terminal geometry and resize authority state", async () => {
		document.body.innerHTML = `
			<div class="dv-content-container">
				<div class="structured-terminal-host">
					<div
						data-testid="structured-terminal-presentation"
						data-terminal-surface-id="window:main:desktop:desk-1:pane:agent:agent-a"
						data-terminal-canonical-columns="46"
						data-terminal-viewport-rows="22"
						data-terminal-cell-width="10"
						data-terminal-row-height="20"
					></div>
				</div>
			</div>
		`;
		const host = document.querySelector<HTMLElement>(
			".structured-terminal-host",
		);
		if (!host) throw new Error("structured terminal host fixture is missing");
		Object.defineProperties(host, {
			clientWidth: { value: 460 },
			clientHeight: { value: 600 },
		});
		vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
			new DOMRect(0, 0, 460, 600),
		);

		const handle = handleCliPerformanceReport as unknown as (
			requestId: string,
			params: Record<string, unknown>,
			claim: (requestId: string) => Promise<boolean>,
			collect: () => Promise<unknown>,
		) => Promise<unknown>;
		const result = await handle(
			"request-geometry",
			{},
			vi.fn().mockResolvedValue(true),
			vi.fn().mockResolvedValue({
				complete: true,
				expectedWindowLabels: ["main"],
				missingWindowLabels: [],
				windows: [],
			}),
		);

		expect(result).toMatchObject({
			ok: true,
			terminalGeometry: {
				resizeTransaction: { phase: "idle" },
				surfaces: [
					{
						surfaceId: "window:main:desktop:desk-1:pane:agent:agent-a",
						canonical: { columns: 46, rows: 22 },
						fit: { columns: 46, rows: 30 },
						host: { clientWidth: 460, clientHeight: 600 },
					},
				],
			},
		});
	});

	it("includes terminal resources owned by a secondary WebView", async () => {
		const collect = vi.fn().mockResolvedValue({
			complete: true,
			expectedWindowLabels: ["main", "agent-session-1"],
			missingWindowLabels: [],
			totals: {
				terminalSurfaces: 1,
				terminalModelBytes: 512,
			},
			windows: [
				{
					windowLabel: "agent-session-1",
					totals: { terminalSurfaces: 1, terminalModelBytes: 512 },
				},
			],
		});
		const handle = handleCliPerformanceReport as unknown as (
			requestId: string,
			params: Record<string, unknown>,
			claim: (requestId: string) => Promise<boolean>,
			collect: () => Promise<unknown>,
		) => Promise<unknown>;

		await expect(
			handle("request-1", {}, vi.fn().mockResolvedValue(true), collect),
		).resolves.toMatchObject({
			ok: true,
			multiWindow: {
				complete: true,
				totals: { terminalSurfaces: 1, terminalModelBytes: 512 },
			},
		});
		expect(collect).toHaveBeenCalledOnce();
	});
});
