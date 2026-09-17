// Boot-time resume for interrupted spawn sagas.
//
// The saga journal (sp_*) survives webview reloads and app restarts, and the
// saga entry point rehydrates a stored request and skips completed steps —
// but until now nothing ever called it again after a reload, so an
// interrupted spawn stayed "running" on disk while its orchestration was
// gone (2026-08-04 patric/darwin incident class). This module is the missing
// trigger: scan non-terminal receipts once per boot and re-enter each saga
// sequentially.
//
// Policy:
// - Sequential, never concurrent — parallel resumes could contend on the
//   same repository (worktree creation) and on provider preflight.
// - A receipt older than SPAWN_RESUME_MAX_AGE_MS is not resumed: its
//   worktree/branch context has likely moved underneath it, and silently
//   re-running day-old provisioning is more surprising than surfacing it.
//   Stale receipts are finished as manual_intervention_required so the scan
//   converges instead of reconsidering them every boot.
// - In-flight duplication is prevented by the saga's own runningSagas set;
//   cross-window duplication by the caller's main-window gate.

import { spawnJournal } from "@/lib/ipc";
import { runSpawnSagaFromCli } from "@/lib/sessions/launch/spawnSaga";

export const SPAWN_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TERMINAL_STATES = new Set([
	"succeeded",
	"failed",
	"compensated",
	"manual_intervention_required",
]);

export type SpawnResumeDecision = "resume" | "stale" | "skip";

/** Pure per-receipt decision so the policy is unit-testable. */
export function decideSpawnResume(
	receipt: { state: string; updatedAt: number },
	nowMs: number,
): SpawnResumeDecision {
	if (TERMINAL_STATES.has(receipt.state)) return "skip";
	if (nowMs - receipt.updatedAt > SPAWN_RESUME_MAX_AGE_MS) return "stale";
	return "resume";
}

export interface SpawnResumeReport {
	resumed: string[];
	stale: string[];
	skipped: string[];
}

interface SpawnResumeIo {
	listRunning: () => Promise<Array<{ receiptId: string; state: string; updatedAt: number }>>;
	resume: (receiptId: string) => Promise<void>;
	finishStale: (receiptId: string) => Promise<void>;
	nowMs: () => number;
}

const defaultIo: SpawnResumeIo = {
	listRunning: () => spawnJournal.listRunning(),
	resume: (receiptId) => runSpawnSagaFromCli({ receiptId }),
	finishStale: async (receiptId) => {
		await spawnJournal.append(receiptId, {
			event: "saga_finished",
			state: "manual_intervention_required",
			reason: "stale_on_boot",
		});
	},
	nowMs: () => Date.now(),
};

let ranThisBoot = false;

/** Resume interrupted sagas once per boot. Failures inside one saga are its
 *  own compensation/terminal concern and never block the next receipt. */
export async function resumeInterruptedSpawnSagas(
	io: SpawnResumeIo = defaultIo,
): Promise<SpawnResumeReport> {
	const report: SpawnResumeReport = { resumed: [], stale: [], skipped: [] };
	if (ranThisBoot) return report;
	ranThisBoot = true;
	let receipts: Array<{ receiptId: string; state: string; updatedAt: number }>;
	try {
		receipts = await io.listRunning();
	} catch {
		return report;
	}
	for (const receipt of receipts) {
		if (!receipt?.receiptId) continue;
		const decision = decideSpawnResume(receipt, io.nowMs());
		if (decision === "skip") {
			report.skipped.push(receipt.receiptId);
			continue;
		}
		if (decision === "stale") {
			report.stale.push(receipt.receiptId);
			try {
				await io.finishStale(receipt.receiptId);
			} catch {
				/* leave it for the next boot rather than fail the scan */
			}
			continue;
		}
		report.resumed.push(receipt.receiptId);
		try {
			await io.resume(receipt.receiptId);
		} catch (error) {
			console.warn(`[spawnResume] ${receipt.receiptId} resume failed:`, error);
		}
	}
	return report;
}

/** Test hook: allow a fresh once-per-boot window. */
export function resetSpawnResumeForTest(): void {
	ranThisBoot = false;
}
