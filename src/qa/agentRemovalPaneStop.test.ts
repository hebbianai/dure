// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HmuxRetireExitedReceipt, hmux } from "@/lib/ipc";
import { archiveStoppedSession } from "./agentRemovalPaneStop";

const target = {
	workspaceId: "workspace-qa",
	sessionId: "session-qa",
	terminalEpoch: "terminal-qa",
};
const generation = {
	fence: {
		...target,
		runnerPrincipal: "local-user",
		runnerInstance: "runner-qa",
		channelEpoch: "1",
		hostInstanceId: "host-qa",
	},
	hostProcess: { processId: 123, startMarker: "exact-qa-generation" },
};
const preview: HmuxRetireExitedReceipt = {
	...target,
	generation,
	outcome: "retirable",
};
const busy: HmuxRetireExitedReceipt = {
	...preview,
	outcome: "skipped",
	reason: "lifetime_busy",
};
const retired: HmuxRetireExitedReceipt = { ...preview, outcome: "retired" };

describe("discovery archival in the real pane-stop QA fixture", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("waits for Host shutdown without changing the generation admitted by preview", async () => {
		const retire = vi
			.spyOn(hmux, "retireExitedSessions")
			.mockResolvedValueOnce([preview])
			.mockResolvedValueOnce([busy])
			.mockResolvedValueOnce([retired]);
		const result = expect(archiveStoppedSession(target)).resolves.toEqual(
			retired,
		);
		await Promise.all([result, vi.runAllTimersAsync()]);
		expect(retire.mock.calls).toEqual([
			[[target], false],
			[[{ ...target, generation }], true],
			[[{ ...target, generation }], true],
		]);
	});

	it("does not select a new generation after the admitted generation is replaced", async () => {
		const retire = vi
			.spyOn(hmux, "retireExitedSessions")
			.mockResolvedValueOnce([preview])
			.mockResolvedValueOnce([busy])
			.mockResolvedValueOnce([{ ...busy, reason: "generation_changed" }]);
		const result = expect(archiveStoppedSession(target)).rejects.toThrow(
			"generation_changed",
		);
		await Promise.all([result, vi.runAllTimersAsync()]);
		expect(retire.mock.calls).toEqual([
			[[target], false],
			[[{ ...target, generation }], true],
			[[{ ...target, generation }], true],
		]);
	});

	it("does not retry an apply whose response was lost", async () => {
		const retire = vi
			.spyOn(hmux, "retireExitedSessions")
			.mockResolvedValueOnce([preview])
			.mockRejectedValueOnce(new Error("transport response lost"));
		await expect(archiveStoppedSession(target)).rejects.toThrow(
			"transport response lost",
		);
		expect(retire).toHaveBeenCalledTimes(2);
	});

	it("waits for an exited observation before applying retirement", async () => {
		const retire = vi
			.spyOn(hmux, "retireExitedSessions")
			.mockResolvedValueOnce([{ ...busy, reason: "not_exited" }])
			.mockResolvedValueOnce([preview])
			.mockResolvedValueOnce([retired]);
		const result = expect(archiveStoppedSession(target)).resolves.toEqual(
			retired,
		);
		await Promise.all([result, vi.runAllTimersAsync()]);
		expect(retire.mock.calls.map(([, apply]) => apply)).toEqual([
			false,
			false,
			true,
		]);
	});

	it("rejects a preview for a different terminal before any destructive call", async () => {
		const retire = vi
			.spyOn(hmux, "retireExitedSessions")
			.mockResolvedValueOnce([
				{
					...preview,
					generation: {
						...generation,
						fence: { ...generation.fence, terminalEpoch: "replacement" },
					},
				},
			]);
		await expect(archiveStoppedSession(target)).rejects.toThrow(
			"stopped generation",
		);
		expect(retire).toHaveBeenCalledExactlyOnceWith([target], false);
	});

	it("does not accept a retired receipt for a different session", async () => {
		const retire = vi
			.spyOn(hmux, "retireExitedSessions")
			.mockResolvedValueOnce([preview])
			.mockResolvedValueOnce([{ ...retired, sessionId: "replacement" }]);
		await expect(archiveStoppedSession(target)).rejects.toThrow(
			"QA discovery retirement failed",
		);
		expect(retire).toHaveBeenCalledTimes(2);
	});

	it("bounds waiting for the same busy Host without refreshing destructive authority", async () => {
		const retire = vi
			.spyOn(hmux, "retireExitedSessions")
			.mockResolvedValueOnce([preview])
			.mockResolvedValue([busy]);
		const result = expect(archiveStoppedSession(target)).rejects.toThrow(
			"lifetime_busy",
		);
		await Promise.all([result, vi.runAllTimersAsync()]);
		expect(performance.now()).toBe(20_000);
		expect(retire.mock.calls.filter(([, apply]) => !apply)).toHaveLength(1);
		expect(
			retire.mock.calls
				.slice(1)
				.every(([items, apply]) => apply && items[0].generation === generation),
		).toBe(true);
	});
});
