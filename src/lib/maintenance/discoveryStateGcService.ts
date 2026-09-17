// Scheduled runner for the Hmux local-state GC.
//
// Hmux ships a complete, safety-checked GC (process probes, discovery locks,
// retention policy, preview/apply convergence) — but only the manual
// `hmux doctor` / `hmux gc` CLI ever invoked it. On the 2026-08-24 live
// daily driver the discovery root had accumulated 100 sessions (75 stale,
// 10 immediately eligible) and week-old exited manifests because nothing
// scheduled the authority; every periodic subsystem then paid per-zombie
// cost forever (hebbian-frontend-9rls9). This module only schedules —
// eligibility, protection, registration headroom, and locking stay owned by
// hmux-client. A preview with an unmet budget still advances to apply because
// exact Exited pointers are protected until that apply transaction reconciles
// their create ledger and archive.
//
// User work is never touched: the GC removes retired discovery/state
// entries and completed recovery records; provider conversation logs live
// outside the discovery root entirely.
import {
	clearMaintenanceLaneInterval,
	setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";

/** Off the boot critical path — first pass waits for the app to settle. */
export const DISCOVERY_STATE_GC_BOOT_DELAY_MS = 2 * 60 * 1_000;
/** Retention hygiene, not monitoring: once per day is the cadence. */
export const DISCOVERY_STATE_GC_PASS_INTERVAL_MS = 24 * 60 * 60 * 1_000;

type DiscoveryStateGcMode = "preview" | "apply";

/** The slice of hmux-client's LocalStateGcReport this scheduler reads. */
export interface DiscoveryStateGcReport {
	readonly mode: string;
	readonly discovery?: {
		readonly plannedSessions?: number;
		readonly scannedSessions?: number;
		readonly budgetUnmet?: boolean;
	};
}

interface DiscoveryStateGcLogEvent {
	readonly phase: "applied" | "failed";
	readonly plannedSessions?: number;
	readonly scannedSessions?: number;
	readonly error?: string;
}

interface DiscoveryStateGcDependencies {
	runGc(mode: DiscoveryStateGcMode): Promise<DiscoveryStateGcReport>;
	/** Quiet hygiene: called only when the pass applied work or failed. */
	log(event: DiscoveryStateGcLogEvent): void;
	scheduleInterval?: (callback: () => void, delayMs: number) => unknown;
	clearIntervalHandle?: (handle: unknown) => void;
}

/** Starts the scheduled GC passes. Main-window only — the caller gates. */
export function installDiscoveryStateGcService(
	dependencies: DiscoveryStateGcDependencies,
): () => void {
	const scheduleInterval =
		dependencies.scheduleInterval ??
		((callback, delayMs) => setMaintenanceLaneInterval(callback, delayMs));
	const clearIntervalHandle =
		dependencies.clearIntervalHandle ??
		((handle) =>
			clearMaintenanceLaneInterval(
				handle as ReturnType<typeof setMaintenanceLaneInterval>,
			));
	let disposed = false;
	let passInFlight = false;

	const pass = async () => {
		if (disposed || passInFlight) return;
		passInFlight = true;
		try {
			const preview = await dependencies.runGc("preview");
			if (disposed) return;
			const planned = preview.discovery?.plannedSessions ?? 0;
			if (planned === 0 && preview.discovery?.budgetUnmet !== true) return;
			await dependencies.runGc("apply");
			if (disposed) return;
			dependencies.log({
				phase: "applied",
				plannedSessions: planned,
				scannedSessions: preview.discovery?.scannedSessions,
			});
		} catch (cause) {
			// One line per failed pass; the daily cadence is the retry. A hot
			// retry loop against a sick discovery root is how storms start.
			if (!disposed) {
				dependencies.log({
					phase: "failed",
					error: cause instanceof Error ? cause.message : String(cause),
				});
			}
		} finally {
			passInFlight = false;
		}
	};

	const bootTimer = globalThis.setTimeout(() => {
		void pass();
	}, DISCOVERY_STATE_GC_BOOT_DELAY_MS);
	const dailyTimer = scheduleInterval(() => {
		void pass();
	}, DISCOVERY_STATE_GC_PASS_INTERVAL_MS);

	return () => {
		if (disposed) return;
		disposed = true;
		globalThis.clearTimeout(bootTimer);
		clearIntervalHandle(dailyTimer);
	};
}
