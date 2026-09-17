import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
	spawnJournal: { listRunning: vi.fn(), append: vi.fn() },
}));
vi.mock("@/lib/sessions/launch/spawnSaga", () => ({
	runSpawnSagaFromCli: vi.fn(),
}));

import {
	decideSpawnResume,
	resetSpawnResumeForTest,
	resumeInterruptedSpawnSagas,
	SPAWN_RESUME_MAX_AGE_MS,
} from "@/lib/sessions/launch/spawnResume";

const NOW = 1_700_000_000_000;

describe("decideSpawnResume", () => {
	it("resumes a fresh running receipt", () => {
		expect(decideSpawnResume({ state: "running", updatedAt: NOW - 60_000 }, NOW)).toBe(
			"resume",
		);
	});

	it("marks a receipt past the age ceiling as stale", () => {
		expect(
			decideSpawnResume(
				{ state: "running", updatedAt: NOW - SPAWN_RESUME_MAX_AGE_MS - 1 },
				NOW,
			),
		).toBe("stale");
	});

	it("skips terminal states defensively even if the scan returned them", () => {
		for (const state of [
			"succeeded",
			"failed",
			"compensated",
			"manual_intervention_required",
		]) {
			expect(decideSpawnResume({ state, updatedAt: NOW }, NOW)).toBe("skip");
		}
	});
});

describe("resumeInterruptedSpawnSagas", () => {
	beforeEach(() => {
		resetSpawnResumeForTest();
	});

	function io(receipts: Array<{ receiptId: string; state: string; updatedAt: number }>) {
		return {
			listRunning: vi.fn(async () => receipts),
			resume: vi.fn(async () => {}),
			finishStale: vi.fn(async () => {}),
			nowMs: () => NOW,
		};
	}

	it("resumes fresh receipts sequentially and finishes stale ones", async () => {
		const deps = io([
			{ receiptId: "sp_a", state: "running", updatedAt: NOW - 1000 },
			{ receiptId: "sp_b", state: "running", updatedAt: NOW - SPAWN_RESUME_MAX_AGE_MS - 1 },
		]);
		const report = await resumeInterruptedSpawnSagas(deps);

		expect(report.resumed).toEqual(["sp_a"]);
		expect(report.stale).toEqual(["sp_b"]);
		expect(deps.resume).toHaveBeenCalledTimes(1);
		expect(deps.resume).toHaveBeenCalledWith("sp_a");
		expect(deps.finishStale).toHaveBeenCalledWith("sp_b");
	});

	it("one saga's resume failure never blocks the next receipt", async () => {
		const deps = io([
			{ receiptId: "sp_a", state: "running", updatedAt: NOW - 1000 },
			{ receiptId: "sp_b", state: "running", updatedAt: NOW - 1000 },
		]);
		deps.resume.mockRejectedValueOnce(new Error("saga exploded"));
		const report = await resumeInterruptedSpawnSagas(deps);

		expect(report.resumed).toEqual(["sp_a", "sp_b"]);
		expect(deps.resume).toHaveBeenCalledTimes(2);
	});

	it("runs at most once per boot", async () => {
		const deps = io([{ receiptId: "sp_a", state: "running", updatedAt: NOW - 1000 }]);
		await resumeInterruptedSpawnSagas(deps);
		const second = await resumeInterruptedSpawnSagas(deps);

		expect(deps.listRunning).toHaveBeenCalledTimes(1);
		expect(second.resumed).toEqual([]);
	});

	it("swallows a failed scan — resume is best-effort, never boot-blocking", async () => {
		const deps = io([]);
		deps.listRunning.mockRejectedValueOnce(new Error("backend not ready"));
		const report = await resumeInterruptedSpawnSagas(deps);
		expect(report).toEqual({ resumed: [], stale: [], skipped: [] });
	});
});
