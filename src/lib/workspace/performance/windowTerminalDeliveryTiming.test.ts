// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalInputLatencyTracker } from "@/lib/terminal/interaction/terminalInputLatency";
import { summarizeTerminalInputPerformance } from "./terminalInputPerformanceReport";
import type { WindowReportCollectorBackend } from "./windowReportCollection";
import type { WindowTerminalInputDiagnostics } from "./windowTerminalInputDiagnostics";

afterEach(() => vi.unstubAllEnvs());

describe("cross-window terminal delivery diagnostics", () => {
	it.each(["production", "perf"])(
		"projects only allowed fields in %s",
		async (mode) => {
			vi.resetModules();
			vi.stubEnv("MODE", mode);
			const { collectWindowTerminalInputDiagnostics } = await import(
				"./windowPerformanceReport"
			);
			const tracker = new TerminalInputLatencyTracker({ now: () => 100 });
			tracker.noteInput("terminal-secondary");
			const input = tracker.beginInput({ terminalId: "terminal-secondary" });
			if (!input) throw new Error("sample not admitted");
			tracker.markFailed(input);
			const diagnostics = summarizeTerminalInputPerformance(tracker.snapshot());
			if (!diagnostics) throw new Error("missing diagnostics");
			const timing = {
				carrierFirstResolvedMs: 10,
				carrierLastResolvedMs: 20,
				carrierDecodeStartedMs: 21,
				carrierDecodedMs: 24,
				carrierDecodeWorkMs: 4,
				carrierPartCount: 2,
				carrierBytes: 1024,
				replicaApplyStartedMs: 25,
				replicaAppliedMs: 30,
			};
			Object.assign(diagnostics.recent[0], timing, {
				rawPayload: "private terminal content",
			});
			const remote: WindowTerminalInputDiagnostics = {
				schemaVersion: 1,
				windowLabel: "secondary",
				generatedAtMs: 100,
				latestSampleAgeMs: 0,
				eventLoopLag: {
					visible: true,
					focused: true,
					contextChangedAtMs: 1,
					lastSampleAtMs: null,
					sampleCount: 0,
					recentP95Ms: null,
					recentMaxMs: null,
				},
				terminalInput: diagnostics,
			};
			let respond: ((payload: unknown) => void) | undefined;
			const backend: WindowReportCollectorBackend<WindowTerminalInputDiagnostics> =
				{
					currentWindowLabel: () => "main",
					listWindowLabels: async () => ["main", "secondary"],
					readLocal: async () => ({ ...remote, windowLabel: "main" }),
					listenResponse: async (listener) => {
						respond = listener;
						return () => undefined;
					},
					emitRequest: async (_label, request) => {
						respond?.({ ...request, sample: remote });
					},
				};
			const result = await collectWindowTerminalInputDiagnostics(backend, 10);
			expect(result.complete).toBe(true);
			const recent = result.windows[1].terminalInput?.recent[0];
			expect(recent).not.toHaveProperty("rawPayload");
			if (mode === "perf") {
				expect(recent).toMatchObject(timing);
				Object.assign(diagnostics.recent[0], { carrierDecodedMs: Infinity });
				await expect(
					collectWindowTerminalInputDiagnostics(backend, 1),
				).resolves.toMatchObject({
					complete: false,
					missingWindowLabels: ["secondary"],
				});
			} else {
				expect(recent).not.toHaveProperty("carrierFirstResolvedMs");
			}
		},
	);
});
