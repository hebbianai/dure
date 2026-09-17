// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DISCOVERY_STATE_GC_BOOT_DELAY_MS,
	DISCOVERY_STATE_GC_PASS_INTERVAL_MS,
	installDiscoveryStateGcService,
} from "@/lib/maintenance/discoveryStateGcService";

function report(planned: number, budgetUnmet = false) {
	return {
		schemaVersion: 1,
		mode: "preview",
		discovery: { plannedSessions: planned, scannedSessions: 100, budgetUnmet },
		recoveryGc: undefined,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("discovery state GC service", () => {
	// Hmux ships a complete, safety-checked state GC (process probes, locks,
	// retention policy, preview/apply convergence) — but only the manual
	// `hmux doctor`/`hmux gc` CLI ever ran it. On the 2026-08-24 live daily
	// driver the discovery root held 100 sessions (75 stale, 10 immediately
	// eligible) because nothing scheduled the authority. The app now runs it
	// on the maintenance lane: once after boot, then daily.
	it("runs a preview after the boot delay and applies planned work", async () => {
		const runGc = vi
			.fn()
			.mockResolvedValueOnce(report(10))
			.mockResolvedValueOnce({ ...report(10), mode: "apply" });
		const log = vi.fn();
		const stop = installDiscoveryStateGcService({
			runGc,
			log,
			scheduleInterval: (callback, ms) => window.setInterval(callback, ms),
			clearIntervalHandle: (handle) => window.clearInterval(handle as number),
		});

		expect(runGc).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(DISCOVERY_STATE_GC_BOOT_DELAY_MS);
		expect(runGc).toHaveBeenNthCalledWith(1, "preview");
		expect(runGc).toHaveBeenNthCalledWith(2, "apply");
		expect(log).toHaveBeenCalledTimes(1);

		stop();
	});

	it("applies when protected exited state leaves the retention budget unmet", async () => {
		const runGc = vi
			.fn()
			.mockResolvedValueOnce(report(0, true))
			.mockResolvedValueOnce({ ...report(0), mode: "apply" });
		const stop = installDiscoveryStateGcService({
			runGc,
			log: vi.fn(),
			scheduleInterval: (callback, ms) => window.setInterval(callback, ms),
			clearIntervalHandle: (handle) => window.clearInterval(handle as number),
		});

		await vi.advanceTimersByTimeAsync(DISCOVERY_STATE_GC_BOOT_DELAY_MS);

		expect(runGc).toHaveBeenNthCalledWith(1, "preview");
		expect(runGc).toHaveBeenNthCalledWith(2, "apply");
		stop();
	});

	it("stays silent and skips apply when nothing is eligible", async () => {
		const runGc = vi.fn().mockResolvedValue(report(0));
		const log = vi.fn();
		const stop = installDiscoveryStateGcService({
			runGc,
			log,
			scheduleInterval: (callback, ms) => window.setInterval(callback, ms),
			clearIntervalHandle: (handle) => window.clearInterval(handle as number),
		});

		await vi.advanceTimersByTimeAsync(DISCOVERY_STATE_GC_BOOT_DELAY_MS);
		expect(runGc).toHaveBeenCalledTimes(1);
		expect(runGc).toHaveBeenCalledWith("preview");
		// Quiet hygiene: a pass that found nothing writes nothing (SOUL §6).
		expect(log).not.toHaveBeenCalled();

		stop();
	});

	it("repeats the pass on the daily interval", async () => {
		const runGc = vi.fn().mockResolvedValue(report(0));
		const stop = installDiscoveryStateGcService({
			runGc,
			log: vi.fn(),
			scheduleInterval: (callback, ms) => window.setInterval(callback, ms),
			clearIntervalHandle: (handle) => window.clearInterval(handle as number),
		});

		await vi.advanceTimersByTimeAsync(DISCOVERY_STATE_GC_BOOT_DELAY_MS);
		expect(runGc).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(DISCOVERY_STATE_GC_PASS_INTERVAL_MS);
		expect(runGc).toHaveBeenCalledTimes(2);

		stop();
	});

	it("logs a failure once and keeps the daily cadence instead of retrying hot", async () => {
		const runGc = vi
			.fn()
			.mockRejectedValue(new Error("hmux_state_gc_root_unreadable"));
		const log = vi.fn();
		const stop = installDiscoveryStateGcService({
			runGc,
			log,
			scheduleInterval: (callback, ms) => window.setInterval(callback, ms),
			clearIntervalHandle: (handle) => window.clearInterval(handle as number),
		});

		await vi.advanceTimersByTimeAsync(DISCOVERY_STATE_GC_BOOT_DELAY_MS);
		expect(runGc).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(runGc).toHaveBeenCalledTimes(1);

		stop();
	});

	it("stop cancels both the boot delay and the daily interval", async () => {
		const runGc = vi.fn().mockResolvedValue(report(0));
		const stop = installDiscoveryStateGcService({
			runGc,
			log: vi.fn(),
			scheduleInterval: (callback, ms) => window.setInterval(callback, ms),
			clearIntervalHandle: (handle) => window.clearInterval(handle as number),
		});
		stop();

		await vi.advanceTimersByTimeAsync(
			DISCOVERY_STATE_GC_BOOT_DELAY_MS + DISCOVERY_STATE_GC_PASS_INTERVAL_MS,
		);
		expect(runGc).not.toHaveBeenCalled();
	});
});
