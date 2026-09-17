import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRestartParticipant,
	runPreparedRestart,
	type RestartRequest,
	type RestartResponse,
	type RestartTransport,
} from "./appRestartProtocol";

function fixture() {
	let receive: (response: RestartResponse) => void = () => {};
	const trace: string[] = [];
	const runtimes = ["main", "win-editor"].map((window) => ({
		window,
		realm: `${window}-realm`,
		holdInput: vi.fn((_cancel: () => void) => {
			trace.push(`hold:${window}`);
			return vi.fn(() => trace.push(`release:${window}`));
		}),
		checkpoint: vi.fn<() => Promise<() => void>>(async () => {
			trace.push(`draft:${window}`);
			return vi.fn(() => {
				trace.push(`resume:${window}`);
			});
		}),
		settle: vi.fn(async () => {
			trace.push(`flush:${window}`);
		}),
		respond: vi.fn(async (response: RestartResponse) => {
			receive(response);
		}),
	}));
	const participants = runtimes.map(createRestartParticipant);
	const transport: RestartTransport = {
		owner: "main",
		windows: vi.fn(async () => ["main", "win-editor"]),
		send: vi.fn(async (request: RestartRequest) => {
			await Promise.all(
				participants.map((participant) => participant.handle(request)),
			);
		}),
		listen: vi.fn(async (listener) => {
			receive = listener;
			return vi.fn(() => {
				receive = () => {};
			});
		}),
	};
	return { trace, runtimes, participants, transport };
}

afterEach(() => vi.useRealTimers());

describe("prepared app restart", () => {
	it("checkpoints every window before installation and rechecks the same realms before restart", async () => {
		const { trace, runtimes, transport } = fixture();
		await runPreparedRestart(transport, async (verify) => {
			expect(trace).toContain("flush:win-editor");
			expect(trace).not.toContain("release:main");
			trace.push("install");
			await verify();
			trace.push("restart");
		});
		expect(trace.indexOf("install")).toBeGreaterThan(
			trace.indexOf("flush:win-editor"),
		);
		expect(trace.indexOf("release:main")).toBeGreaterThan(
			trace.indexOf("restart"),
		);
		for (const runtime of runtimes) {
			expect(runtime.checkpoint).toHaveBeenCalledTimes(2);
			expect(runtime.settle).toHaveBeenCalledTimes(2);
		}
	});

	it("does not install after a secondary window storage failure and releases every held window", async () => {
		const { trace, runtimes, transport } = fixture();
		runtimes[1].settle.mockRejectedValueOnce(new Error("disk full"));
		const install = vi.fn();
		await expect(runPreparedRestart(transport, install)).rejects.toThrow(
			"disk full",
		);
		expect(install).not.toHaveBeenCalled();
		expect(trace).toContain("release:main");
		expect(trace).toContain("resume:win-editor");
	});

	it("refuses a window created during preparation before installation", async () => {
		const { transport } = fixture();
		vi.mocked(transport.windows)
			.mockResolvedValueOnce(["main"])
			.mockResolvedValue(["main", "win-new"]);
		const install = vi.fn();
		await expect(runPreparedRestart(transport, install)).rejects.toThrow(
			"app_restart_windows_changed",
		);
		expect(install).not.toHaveBeenCalled();
	});

	it("refuses a window changed or reloaded during installation before relaunch", async () => {
		const { transport, participants } = fixture();
		const restart = vi.fn();
		await expect(
			runPreparedRestart(transport, async (verify) => {
				participants[1].dispose();
				await verify();
				restart();
			}),
		).rejects.toThrow("app_restart_preparation_missing");
		expect(restart).not.toHaveBeenCalled();
	});

	it("bounds a silent window without installing and always sends release", async () => {
		vi.useFakeTimers();
		const { transport, participants } = fixture();
		vi.mocked(transport.send).mockImplementation(async (request) => {
			await participants[0].handle(request);
		});
		const install = vi.fn();
		const result = expect(
			runPreparedRestart(transport, install, 100),
		).rejects.toThrow("app_restart_window_unresponsive");
		await vi.advanceTimersByTimeAsync(100);
		await result;
		expect(install).not.toHaveBeenCalled();
		expect(transport.send).toHaveBeenLastCalledWith(
			expect.objectContaining({ phase: "release" }),
		);
	});

	it("releases a checkpoint that finishes after its request was cancelled", async () => {
		const { runtimes, participants } = fixture();
		let finish!: (resume: () => void) => void;
		runtimes[0].checkpoint.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const request = {
			id: crypto.randomUUID(),
			owner: "main",
			phase: "prepare" as const,
		};
		const pending = participants[0].handle(request);
		await participants[0].handle({ ...request, phase: "release" });
		const resume = vi.fn();
		finish(resume);
		await pending;
		expect(resume).toHaveBeenCalledOnce();
		expect(runtimes[0].settle).not.toHaveBeenCalled();
		expect(runtimes[0].respond).toHaveBeenCalledWith(
			expect.objectContaining({ error: "app_restart_cancelled" }),
		);
	});

	it("does not restart after the user cancels input preparation during installation", async () => {
		const { runtimes, transport } = fixture();
		const restart = vi.fn();
		await expect(
			runPreparedRestart(transport, async (verify) => {
				runtimes[1].holdInput.mock.calls[0][0]();
				await verify();
				restart();
			}),
		).rejects.toThrow("app_restart_preparation_missing");
		expect(restart).not.toHaveBeenCalled();
	});

	it("refuses a different realm with the same window label before restart", async () => {
		const { runtimes, transport } = fixture();
		const original = runtimes[1].respond.getMockImplementation()!;
		runtimes[1].respond.mockImplementation(async (response) =>
			original({
				...response,
				realm: response.phase === "verify" ? "replacement" : response.realm,
			}),
		);
		const restart = vi.fn();
		await expect(
			runPreparedRestart(transport, async (verify) => {
				await verify();
				restart();
			}),
		).rejects.toThrow("app_restart_window_reloaded");
		expect(restart).not.toHaveBeenCalled();
	});

	it("re-checkpoints changes during installation and refuses a new persistence failure", async () => {
		const { runtimes, transport } = fixture();
		const restart = vi.fn();
		await expect(
			runPreparedRestart(transport, async (verify) => {
				runtimes[1].checkpoint.mockRejectedValueOnce(
					new Error("new draft could not be retained"),
				);
				await verify();
				restart();
			}),
		).rejects.toThrow("new draft could not be retained");
		expect(restart).not.toHaveBeenCalled();
		expect(runtimes[1].checkpoint).toHaveBeenCalledTimes(2);
	});

	it("does not install when two windows retain different drafts for the same file", async () => {
		const { runtimes, transport } = fixture();
		runtimes[0].checkpoint.mockResolvedValueOnce(
			Object.assign(vi.fn(), { drafts: [["file", "first"]] }),
		);
		runtimes[1].checkpoint.mockResolvedValueOnce(
			Object.assign(vi.fn(), { drafts: [["file", "second"]] }),
		);
		const install = vi.fn();
		await expect(runPreparedRestart(transport, install)).rejects.toThrow(
			"app_restart_draft_conflict",
		);
		expect(install).not.toHaveBeenCalled();
	});
});
