import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginLargeViewReturnToWindow,
	type LargeViewReturnLifecycleRequestBackend,
	type LargeViewReturnLifecycleSourceBackend,
	type LargeViewReturnRequestBackend,
	type LargeViewReturnSourceBackend,
	prepareLargeViewReturn,
	prepareLargeViewReturnToWindow,
	subscribeLargeViewReturnLifecycleRequests,
	subscribeLargeViewReturnPreparation,
} from "./largeViewReturnHandoff";
import { LargeViewReturnSourceTransaction } from "./largeViewReturnTransaction";

const identity = { workspaceId: "workspace-1", sessionId: "session-1" };
const exactIdentity = {
	...identity,
	sourcePaneOwnerId: "desktop-2:agent:1",
};

describe("large-view return handoff", () => {
	afterEach(() => vi.useRealTimers());

	it("waits for the matching source acknowledgement", async () => {
		let ready: ((payload: unknown) => void) | undefined;
		const stop = vi.fn();
		const backend: LargeViewReturnRequestBackend = {
			listenReady: vi.fn(async (listener) => {
				ready = listener;
				return stop;
			}),
			emitPrepare: vi.fn(async (_targetWindowLabel, payload) => {
				ready?.({
					workspaceId: payload.workspaceId,
					sessionId: payload.sessionId,
					generation: payload.generation,
					...(payload.sourcePaneOwnerId
						? { sourcePaneOwnerId: payload.sourcePaneOwnerId }
						: {}),
				});
			}),
		};

		await expect(
			prepareLargeViewReturn(identity, "win-session-agent-1", backend),
		).resolves.toBe(true);
		expect(stop).toHaveBeenCalledOnce();
		expect(backend.emitPrepare).toHaveBeenCalledWith(
			"main",
			expect.objectContaining({
				workspaceId: "workspace-1",
				sessionId: "session-1",
				replyWindowLabel: "win-session-agent-1",
			}),
		);
	});

	it("targets the non-main workspace that opened the large view", async () => {
		let ready: ((payload: unknown) => void) | undefined;
		const backend: LargeViewReturnRequestBackend = {
			listenReady: vi.fn(async (listener) => {
				ready = listener;
				return vi.fn();
			}),
			emitPrepare: vi.fn(async (_targetWindowLabel, payload) => {
				ready?.({
					workspaceId: payload.workspaceId,
					sessionId: payload.sessionId,
					generation: payload.generation,
					...(payload.sourcePaneOwnerId
						? { sourcePaneOwnerId: payload.sourcePaneOwnerId }
						: {}),
				});
			}),
		};

		await expect(
			prepareLargeViewReturnToWindow(
				exactIdentity,
				"win-session-agent-1",
				"win-workspace-2",
				backend,
			),
		).resolves.toBe(true);
		expect(backend.emitPrepare).toHaveBeenCalledWith(
			"win-workspace-2",
			expect.objectContaining({
				workspaceId: "workspace-1",
				sessionId: "session-1",
				sourcePaneOwnerId: "desktop-2:agent:1",
			}),
		);
	});

	it("delivers retirement only after the prepared generation is explicitly retired", async () => {
		let readyListener: ((payload: unknown) => void) | undefined;
		let prepareListener: ((payload: unknown) => void) | undefined;
		let retiredListener: ((payload: unknown) => void) | undefined;
		const request: LargeViewReturnLifecycleRequestBackend = {
			listenReady: async (listener) => {
				readyListener = listener;
				return () => {};
			},
			emitPrepare: async (_windowLabel, payload) => {
				prepareListener?.(payload);
			},
			emitRetired: async (_windowLabel, payload) => {
				retiredListener?.(payload);
			},
		};
		const source: LargeViewReturnLifecycleSourceBackend = {
			listenPrepare: async (listener) => {
				prepareListener = listener;
				return () => {};
			},
			emitReady: async (_windowLabel, payload) => {
				readyListener?.(payload);
			},
			listenRetired: async (listener) => {
				retiredListener = listener;
				return () => {};
			},
		};
		const retired = vi.fn();
		const stop = subscribeLargeViewReturnLifecycleRequests(
			{ prepare: () => true, retired },
			source,
		);
		await vi.waitFor(() => {
			expect(prepareListener).toBeTypeOf("function");
			expect(retiredListener).toBeTypeOf("function");
		});

		const prepared = await beginLargeViewReturnToWindow(
			exactIdentity,
			"win-session-agent-1",
			"win-workspace-2",
			request,
		);
		expect(prepared).toBeDefined();
		expect(retired).not.toHaveBeenCalled();

		await prepared?.markLargeSurfaceRetired();
		expect(retired).toHaveBeenCalledWith({
			...exactIdentity,
			generation: prepared?.generation,
		});
		stop();
	});

	it("installs the retirement listener before accepting a prepare request", async () => {
		let finishRetiredListener!: (stop: () => void) => void;
		const backend: LargeViewReturnLifecycleSourceBackend = {
			listenRetired: vi.fn(
				() =>
					new Promise<() => void>((resolve) => {
						finishRetiredListener = resolve;
					}),
			),
			listenPrepare: vi.fn(async () => () => {}),
			emitReady: vi.fn(async () => {}),
		};
		const stop = subscribeLargeViewReturnLifecycleRequests(
			{ prepare: () => true, retired: vi.fn() },
			backend,
		);

		expect(backend.listenPrepare).not.toHaveBeenCalled();
		finishRetiredListener(() => {});
		await vi.waitFor(() =>
			expect(backend.listenPrepare).toHaveBeenCalledOnce(),
		);
		stop();
	});

	it("conceals, acknowledges, and completes only the exact opener pane", async () => {
		const listeners: Array<(payload: unknown) => void> = [];
		const backend: LargeViewReturnSourceBackend = {
			listenPrepare: vi.fn(async (listener) => {
				listeners.push(listener);
				return vi.fn();
			}),
			emitReady: vi.fn(async () => {}),
		};
		const firstVisibility = { conceal: vi.fn(), reveal: vi.fn() };
		const openerVisibility = { conceal: vi.fn(), reveal: vi.fn() };
		const first = new LargeViewReturnSourceTransaction(firstVisibility);
		const opener = new LargeViewReturnSourceTransaction(openerVisibility);
		const stopFirst = subscribeLargeViewReturnPreparation(
			{ ...identity, sourcePaneOwnerId: "desktop-2:agent:replica" },
			(generation) => first.prepare(generation),
			backend,
		);
		const stopOpener = subscribeLargeViewReturnPreparation(
			exactIdentity,
			(generation) => opener.prepare(generation),
			backend,
		);
		await vi.waitFor(() => expect(listeners).toHaveLength(2));

		for (const listener of listeners) {
			listener({
				...exactIdentity,
				generation: "return-exact",
				replyWindowLabel: "win-session-agent-1",
				expiresAtMs: Date.now() + 1_000,
			});
		}

		expect(firstVisibility.conceal).not.toHaveBeenCalled();
		expect(first.currentGeneration()).toBeUndefined();
		expect(openerVisibility.conceal).toHaveBeenCalledOnce();
		expect(opener.currentGeneration()).toBe("return-exact");
		expect(backend.emitReady).toHaveBeenCalledOnce();
		expect(backend.emitReady).toHaveBeenCalledWith("win-session-agent-1", {
			...exactIdentity,
			generation: "return-exact",
		});
		expect(first.complete("return-exact")).toBe(false);
		expect(opener.complete("return-exact")).toBe(true);
		expect(firstVisibility.reveal).not.toHaveBeenCalled();
		expect(openerVisibility.reveal).toHaveBeenCalledOnce();
		stopFirst();
		stopOpener();
	});

	it("fails open and retires a late subscription", async () => {
		vi.useFakeTimers();
		let resolveListen!: (stop: () => void) => void;
		const stop = vi.fn();
		const backend: LargeViewReturnRequestBackend = {
			listenReady: vi.fn(
				() =>
					new Promise<() => void>((resolve) => {
						resolveListen = resolve;
					}),
			),
			emitPrepare: vi.fn(async () => {}),
		};
		const result = prepareLargeViewReturn(
			identity,
			"win-session-agent-1",
			backend,
			100,
		);

		await vi.advanceTimersByTimeAsync(100);
		await expect(result).resolves.toBe(false);
		resolveListen(stop);
		await vi.runAllTimersAsync();
		expect(stop).toHaveBeenCalledOnce();
		expect(backend.emitPrepare).not.toHaveBeenCalled();
	});

	it("keeps the source expiry tied to the requester's original deadline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		let resolveListen!: (stop: () => void) => void;
		const backend: LargeViewReturnRequestBackend = {
			listenReady: vi.fn(
				() =>
					new Promise<() => void>((resolve) => {
						resolveListen = resolve;
					}),
			),
			emitPrepare: vi.fn(async () => {}),
		};
		const result = prepareLargeViewReturn(
			identity,
			"win-session-agent-1",
			backend,
			100,
		);

		await vi.advanceTimersByTimeAsync(90);
		resolveListen(vi.fn());
		await Promise.resolve();
		expect(backend.emitPrepare).toHaveBeenCalledWith(
			"main",
			expect.objectContaining({ expiresAtMs: 1_100 }),
		);
		await vi.advanceTimersByTimeAsync(10);
		await expect(result).resolves.toBe(false);
	});

	it("allows an inactive source pane one close budget to remount", async () => {
		vi.useFakeTimers();
		let ready: ((payload: unknown) => void) | undefined;
		const backend: LargeViewReturnRequestBackend = {
			listenReady: vi.fn(async (listener) => {
				ready = listener;
				return vi.fn();
			}),
			emitPrepare: vi.fn(async (_targetWindowLabel, payload) => {
				setTimeout(() => {
					ready?.({
						workspaceId: payload.workspaceId,
						sessionId: payload.sessionId,
						generation: payload.generation,
						...(payload.sourcePaneOwnerId
							? { sourcePaneOwnerId: payload.sourcePaneOwnerId }
							: {}),
					});
				}, 500);
			}),
		};
		const result = prepareLargeViewReturnToWindow(
			exactIdentity,
			"win-session-agent-1",
			"win-workspace-2",
			backend,
		);

		await vi.advanceTimersByTimeAsync(500);
		await expect(result).resolves.toBe(true);
	});

	it("acknowledges only the matching eligible source", async () => {
		let prepareListener: ((payload: unknown) => void) | undefined;
		const backend: LargeViewReturnSourceBackend = {
			listenPrepare: vi.fn(async (listener) => {
				prepareListener = listener;
				return vi.fn();
			}),
			emitReady: vi.fn(async () => {}),
		};
		const prepare = vi.fn(() => true);
		subscribeLargeViewReturnPreparation(identity, prepare, backend);
		await vi.waitFor(() => expect(prepareListener).toBeTypeOf("function"));

		prepareListener?.({
			workspaceId: "other-workspace",
			sessionId: "session-1",
			generation: "return-wrong",
			replyWindowLabel: "win-session-agent-1",
			expiresAtMs: Date.now() + 1_000,
		});
		prepareListener?.({
			...identity,
			generation: "return-1",
			replyWindowLabel: "win-session-agent-1",
			expiresAtMs: Date.now() + 1_000,
		});

		expect(prepare).toHaveBeenCalledOnce();
		expect(backend.emitReady).toHaveBeenCalledWith("win-session-agent-1", {
			...identity,
			generation: "return-1",
		});
	});

	it("ignores a prepare event that arrives after the requester deadline", async () => {
		let prepareListener: ((payload: unknown) => void) | undefined;
		const backend: LargeViewReturnSourceBackend = {
			listenPrepare: vi.fn(async (listener) => {
				prepareListener = listener;
				return vi.fn();
			}),
			emitReady: vi.fn(async () => {}),
		};
		const prepare = vi.fn(() => true);
		subscribeLargeViewReturnPreparation(identity, prepare, backend, () => 500);
		await vi.waitFor(() => expect(prepareListener).toBeTypeOf("function"));

		prepareListener?.({
			...identity,
			generation: "return-too-late",
			replyWindowLabel: "win-session-agent-1",
			expiresAtMs: 499,
		});

		expect(prepare).not.toHaveBeenCalled();
		expect(backend.emitReady).not.toHaveBeenCalled();
	});

	it("rolls back concealment when the acknowledgement cannot be delivered", async () => {
		let prepareListener: ((payload: unknown) => void) | undefined;
		const backend: LargeViewReturnSourceBackend = {
			listenPrepare: vi.fn(async (listener) => {
				prepareListener = listener;
				return vi.fn();
			}),
			emitReady: vi.fn(async () => {
				throw new Error("reply window closed");
			}),
		};
		const visibility = { conceal: vi.fn(), reveal: vi.fn() };
		const transaction = new LargeViewReturnSourceTransaction(visibility);
		subscribeLargeViewReturnPreparation(
			identity,
			(generation) => {
				if (!transaction.prepare(generation)) return false;
				return () => transaction.complete(generation);
			},
			backend,
		);
		await vi.waitFor(() => expect(prepareListener).toBeTypeOf("function"));

		prepareListener?.({
			...identity,
			generation: "return-orphaned",
			replyWindowLabel: "closed-window",
			expiresAtMs: Date.now() + 1_000,
		});
		await vi.waitFor(() => expect(visibility.reveal).toHaveBeenCalledOnce());

		expect(visibility.conceal).toHaveBeenCalledOnce();
		expect(transaction.currentGeneration()).toBeUndefined();
	});
});
