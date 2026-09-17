import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import {
	hmuxStandaloneBinding,
	remoteHmuxManagedBinding,
	remoteHmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import {
	bellEventRecord as bellEventRecordFixture,
	viewportFrameRecord as frameRecordFixture,
	viewportFramePartRecords,
} from "@/test/terminalRecordFixtures";
import type { SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({
	attachLocal: vi.fn(),
	detach: vi.fn().mockResolvedValue(undefined),
	attachRemote: vi.fn(),
	resolveRemote: vi.fn(),
	pullRecords: new Map<string, ArrayBuffer[]>(),
	pullRequestCounts: new Map<string, number>(),
	pullWaiters: new Map<
		string,
		Array<{
			resolve(record: ArrayBuffer): void;
			reject(cause: unknown): void;
		}>
	>(),
}));

vi.mock("@/lib/ipc", () => ({
	hmux: {
		detachStructuredTerminal: mocks.detach,
		attachStructuredTerminal: (request: { observerId: string }) =>
			adaptPulledAttach(mocks.attachLocal, request),
		attachRemoteStructuredTerminal: (request: { observerId: string }) =>
			adaptPulledAttach(mocks.attachRemote, request),
		nextStructuredTerminalRecord: (observerId: string) =>
			nextPulledRecord(observerId),
	},
}));

async function adaptPulledAttach(
	attach: typeof mocks.attachLocal,
	request: { observerId: string },
) {
	let deliveredBeforeReceipt = 0;
	let receiptResolved = false;
	const receipt = await attach({
		...request,
		onRecord: (record: ArrayBuffer) => {
			if (!receiptResolved) deliveredBeforeReceipt += 1;
			deliverPulledRecord(request.observerId, record);
		},
	});
	receiptResolved = true;
	return {
		...receipt,
		initialDeliveryRecordCount: Math.max(
			receipt.initialDeliveryRecordCount ?? 0,
			deliveredBeforeReceipt,
		),
	};
}

function deliverPulledRecord(observerId: string, record: ArrayBuffer): void {
	const waiter = mocks.pullWaiters.get(observerId)?.shift();
	if (waiter) {
		waiter.resolve(record);
		return;
	}
	const queued = mocks.pullRecords.get(observerId) ?? [];
	queued.push(record);
	mocks.pullRecords.set(observerId, queued);
}

function nextPulledRecord(observerId: string): Promise<ArrayBuffer> {
	mocks.pullRequestCounts.set(
		observerId,
		(mocks.pullRequestCounts.get(observerId) ?? 0) + 1,
	);
	const record = mocks.pullRecords.get(observerId)?.shift();
	if (record) return Promise.resolve(record);
	return new Promise((resolve, reject) => {
		const waiters = mocks.pullWaiters.get(observerId) ?? [];
		waiters.push({ resolve, reject });
		mocks.pullWaiters.set(observerId, waiters);
	});
}

vi.mock("@/lib/hmux/remote/remoteHmuxControllerResolution", () => ({
	resolveRemoteHmuxStandaloneController: mocks.resolveRemote,
}));

import {
	attachStructuredTerminalRecords as attachStructuredTerminalRecordsWithAccess,
	StructuredTerminalAttachInitialFrameError,
	type StructuredTerminalRecordAttachRequest,
} from "@/lib/terminal/structuredTerminalRecordAdapter";

const attachStructuredTerminalRecords = (
	request: Omit<StructuredTerminalRecordAttachRequest, "access">,
) =>
	attachStructuredTerminalRecordsWithAccess({
		...request,
		access: "writer",
	});

const receipt = {
	terminalEpoch: "terminal-1",
	throughOutputSeq: "1",
	stateRevision: "1",
	initialDeliveryRecordCount: 0,
	selectedCapabilities: [],
};

const TEST_EPOCH = "terminal-1";

function viewportFrameRecord(
	revision: bigint,
	throughEventId = 0n,
	columns = 1,
): Uint8Array {
	return frameRecordFixture({
		terminalEpoch: TEST_EPOCH,
		projectionRevision: revision,
		damageBaseProjectionRevision: revision - 1n,
		throughEventId,
		columns,
		texts: ["x".repeat(columns)],
	});
}

function multipartViewportFrameRecords(
	revision: bigint,
	throughEventId: bigint,
): readonly Uint8Array[] {
	return viewportFramePartRecords(
		viewportFrameRecord(revision, throughEventId),
	);
}

function bellEventRecord(eventId: bigint, revision: bigint): Uint8Array {
	return bellEventRecordFixture(eventId, revision, TEST_EPOCH);
}

describe("structured terminal record carrier", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		terminalInputLatency.resetMeasurements();
	});

	beforeEach(() => {
		for (const waiters of mocks.pullWaiters.values()) {
			for (const waiter of waiters) waiter.reject(new Error("test reset"));
		}
		mocks.pullRecords.clear();
		mocks.pullRequestCounts.clear();
		mocks.pullWaiters.clear();
		mocks.detach.mockReset().mockResolvedValue(undefined);
		mocks.attachLocal.mockReset().mockResolvedValue(receipt);
		mocks.attachRemote.mockReset().mockResolvedValue(receipt);
		mocks.resolveRemote.mockReset();
	});

	it("measures a sampled multipart delivery only in the perf build", async () => {
		vi.stubEnv("MODE", "perf");
		const attached = await attachStructuredTerminalRecords({
			observerId: "observer-a",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
		});
		attached.startDelivery();
		// The long pull can already be pending when the user starts typing.
		const pending = attached.readRecord();
		terminalInputLatency.noteInput("surface-a");
		const sample = terminalInputLatency.beginInput({ terminalId: "surface-a" });
		const parts = multipartViewportFrameRecords(1n, 0n);
		for (const part of parts) {
			deliverPulledRecord("observer-a", part.buffer as ArrayBuffer);
		}
		const delivered = await pending;
		expect(delivered.kind).toBe("terminal");
		expect(delivered).toMatchObject({
			deliveryTiming: {
				sampleSequence: sample?.sequence,
				partCount: parts.length,
				encodedBytes: parts.reduce((sum, part) => sum + part.byteLength, 0),
				firstCarrierResolvedAt: expect.any(Number),
				lastCarrierResolvedAt: expect.any(Number),
				decodedAt: expect.any(Number),
				decodeWorkMs: expect.any(Number),
			},
		});
	});

	it.each(["production", "development"])("does not read a diagnostic clock in %s", async (mode) => {
		vi.stubEnv("MODE", mode);
		const attached = await attachStructuredTerminalRecords({
			observerId: "observer-a",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
		});
		attached.startDelivery();
		terminalInputLatency.noteInput("surface-a");
		terminalInputLatency.beginInput({ terminalId: "surface-a" });
		const clock = vi.spyOn(performance, "now");
		const pending = attached.readRecord();
		deliverPulledRecord("observer-a", viewportFrameRecord(1n).buffer as ArrayBuffer);
		const delivered = await pending;
		expect(delivered.kind).toBe("terminal");
		expect(delivered).not.toHaveProperty("deliveryTiming");
		expect(clock).not.toHaveBeenCalled();
	});

	it("uses the local typed surface without constructing a legacy transport", async () => {
		const prepareAttach = vi.fn().mockResolvedValue(undefined);
		const binding = hmuxStandaloneBinding("session-a", "workspace-a");

		await attachStructuredTerminalRecords({
			observerId: "observer-a",
			surfaceId: "surface-a",
			binding,
			sshHosts: [],
			prepareAttach,
		});

		expect(prepareAttach).toHaveBeenCalledOnce();
		expect(mocks.attachLocal).toHaveBeenCalledOnce();
		expect(mocks.attachRemote).not.toHaveBeenCalled();
	});

	it("rejects terminal-inferred runtime state at the adapter boundary", async () => {
		mocks.attachLocal.mockImplementation(
			(request: { onRecord(record: ArrayBuffer): void }) => {
				const state = new TextEncoder().encode(
					JSON.stringify({
						kind: "agent_runtime_state",
						state: {
							terminalEpoch: "terminal-1",
							revision: "7",
							observedThroughOutputSeq: "1",
							lifecycle: "running",
							activity: "waiting",
							attention: "none",
							source: "terminal_inference",
							turnCompletedCount: "0",
						},
					}),
				);
				request.onRecord(state.buffer as ArrayBuffer);
				return Promise.resolve({ ...receipt, initialDeliveryRecordCount: 1 });
			},
		);

		const attached = await attachStructuredTerminalRecords({
			observerId: "observer-a",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
		});

		expect(attached.startDelivery()).toEqual([
			{
				kind: "failure",
				reason: "structured terminal adapter sent an invalid control record",
				encodedByteLength: 0,
			},
		]);
	});

	it("carries generic agent identity transitions in the ordered pull stream", async () => {
		mocks.attachLocal.mockImplementation(
			(request: { onRecord(record: ArrayBuffer): void }) => {
				const identity = new TextEncoder().encode(
					JSON.stringify({
						kind: "agent_identity",
						identity: {
							terminalEpoch: "terminal-1",
							observedThroughOutputSeq: "1",
							agent: "codex",
							source: "process_inspection",
						},
					}),
				);
				request.onRecord(identity.buffer as ArrayBuffer);
				return Promise.resolve({ ...receipt, initialDeliveryRecordCount: 1 });
			},
		);

		const attached = await attachStructuredTerminalRecords({
			observerId: "observer-a",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
		});

		expect(attached.startDelivery()).toMatchObject([
			{
				kind: "adapter",
				record: {
					kind: "agent_identity",
					identity: { agent: "codex", source: "process_inspection" },
				},
			},
		]);
	});

	it("carries working directory projections in the ordered pull stream", async () => {
		mocks.attachLocal.mockImplementation(
			(request: { onRecord(record: ArrayBuffer): void }) => {
				const workingDirectory = new TextEncoder().encode(
					JSON.stringify({
						kind: "working_directory",
						workingDirectory: {
							terminalEpoch: "terminal-1",
							observedThroughOutputSeq: "1",
							path: "/Users/dev/project",
							source: "process_inspection",
						},
					}),
				);
				request.onRecord(workingDirectory.buffer as ArrayBuffer);
				return Promise.resolve({ ...receipt, initialDeliveryRecordCount: 1 });
			},
		);

		const attached = await attachStructuredTerminalRecords({
			observerId: "observer-a",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
		});

		expect(attached.startDelivery()).toMatchObject([
			{
				kind: "adapter",
				record: {
					kind: "working_directory",
					workingDirectory: {
						path: "/Users/dev/project",
						source: "process_inspection",
					},
				},
			},
		]);
	});

	it("releases the decoded initial frame while the live attachment remains", async () => {
		mocks.attachLocal.mockImplementation(
			(request: { onRecord(record: ArrayBuffer): void }) => {
				const seed = viewportFrameRecord(1n, 0n, 512);
				request.onRecord(seed.buffer as ArrayBuffer);
				return Promise.resolve({ ...receipt, initialDeliveryRecordCount: 1 });
			},
		);
		const attachment = await attachStructuredTerminalRecords({
			observerId: "observer-release-seed",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
		});
		const WeakReference = (
			globalThis as typeof globalThis & {
				WeakRef: new <T extends object>(
					target: T,
				) => {
					deref(): T | undefined;
				};
			}
		).WeakRef;
		const weak = (() => {
			const record = attachment.startDelivery()[0];
			if (!record) throw new Error("initial frame is missing");
			return new WeakReference(record);
		})();
		const [{ setFlagsFromString }, { runInNewContext }] = await Promise.all([
			import("node:v8"),
			import("node:vm"),
		]);
		setFlagsFromString("--expose_gc");
		const collect = runInNewContext("gc") as () => void;
		for (let attempt = 0; attempt < 20 && weak.deref(); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			collect();
		}

		expect(weak.deref()).toBeUndefined();
		expect(attachment.startDelivery()).toEqual([]);
	});

	it("keeps exactly one raw pull active across a multipart frame", async () => {
		const attachment = await attachStructuredTerminalRecords({
			observerId: "observer-a",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
		});
		attachment.startDelivery();
		const reading = attachment.readRecord();
		expect(mocks.pullRequestCounts.get("observer-a")).toBe(1);
		expect(mocks.pullWaiters.get("observer-a")).toHaveLength(1);

		const parts = multipartViewportFrameRecords(2n, 1n);
		deliverPulledRecord("observer-a", parts[0].buffer as ArrayBuffer);
		await vi.waitFor(() =>
			expect(mocks.pullRequestCounts.get("observer-a")).toBe(2),
		);
		expect(mocks.pullWaiters.get("observer-a")).toHaveLength(1);
		deliverPulledRecord("observer-a", parts[1].buffer as ArrayBuffer);

		const record = await reading;
		expect(record.kind).toBe("terminal");
		expect(mocks.pullRequestCounts.get("observer-a")).toBe(2);
	});

	it("enforces the Host receipt's complete initial-frame contract for retained recovery", async () => {
		mocks.attachLocal.mockResolvedValueOnce({
			...receipt,
			initialDeliveryRecordCount: 0,
		});
		const withoutSeed = await attachStructuredTerminalRecords({
			observerId: "observer-missing-seed",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
			requireInitialViewportFrame: true,
		});

		expect(() => withoutSeed.startDelivery()).toThrow(
			StructuredTerminalAttachInitialFrameError,
		);

		mocks.attachLocal.mockImplementationOnce(
			(request: { onRecord(record: ArrayBuffer): void }) => {
				const seed = viewportFrameRecord(1n);
				request.onRecord(seed.buffer as ArrayBuffer);
				return Promise.resolve({ ...receipt, initialDeliveryRecordCount: 1 });
			},
		);
		const withSeed = await attachStructuredTerminalRecords({
			observerId: "observer-with-seed",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
			requireInitialViewportFrame: true,
		});

		expect(withSeed.startDelivery()).toHaveLength(1);
	});

	it("waits across invoke resolution for the counted large initial seed callback", async () => {
		let deliverFromCarrier!: (record: ArrayBuffer) => void;
		mocks.attachLocal.mockImplementation(
			(request: { onRecord(record: ArrayBuffer): void }) => {
				deliverFromCarrier = request.onRecord;
				return Promise.resolve({
					...receipt,
					initialDeliveryRecordCount: 1,
				});
			},
		);
		const attaching = attachStructuredTerminalRecords({
			observerId: "observer-delayed-seed",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
			requireInitialViewportFrame: true,
		});
		let settled = false;
		void attaching.then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(deliverFromCarrier).toBeTypeOf("function"));
		await Promise.resolve();
		expect(settled).toBe(false);

		const seed = viewportFrameRecord(1n, 0n, 512);
		expect(seed.byteLength).toBeGreaterThan(1_024);
		deliverFromCarrier(seed.buffer as ArrayBuffer);

		const attachment = await attaching;
		expect(attachment.startDelivery()).toHaveLength(1);
	});

	it("preserves a counted pre-receipt close over the generic missing-seed failure", async () => {
		mocks.attachLocal.mockImplementation(
			(request: { onRecord(record: ArrayBuffer): void }) => {
				const closed = new TextEncoder().encode(
					JSON.stringify({
						kind: "closed",
						code: "hmux_attach_stream_closed",
						message: "exact initial stream close",
						retryDirective: "never",
					}),
				);
				request.onRecord(closed.buffer as ArrayBuffer);
				return Promise.resolve({
					...receipt,
					initialDeliveryRecordCount: 1,
				});
			},
		);

		const attachment = await attachStructuredTerminalRecords({
			observerId: "observer-closed-before-seed",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
			requireInitialViewportFrame: true,
		});

		expect(attachment.startDelivery()).toMatchObject([
			{
				kind: "adapter",
				record: {
					kind: "closed",
					code: "hmux_attach_stream_closed",
					message: "exact initial stream close",
				},
			},
		]);
	});

	it("preserves counted pre-receipt protocol and control failures", async () => {
		for (const [index, fixture] of [
			{
				record: new TextEncoder().encode("invalid adapter control"),
				expected: /structured terminal adapter sent an invalid control record/,
			},
			{
				record: new TextEncoder().encode(
					JSON.stringify({
						kind: "control",
						body: {
							kind: "error",
							message: "exact initial Host control error",
						},
					}),
				),
				expected: null,
			},
		].entries()) {
			mocks.attachLocal.mockImplementationOnce(
				(request: { onRecord(record: ArrayBuffer): void }) => {
					request.onRecord(fixture.record.buffer as ArrayBuffer);
					return Promise.resolve({
						...receipt,
						initialDeliveryRecordCount: 1,
					});
				},
			);
			const attachment = await attachStructuredTerminalRecords({
				observerId: `observer-initial-failure-${index}`,
				surfaceId: "surface-a",
				binding: hmuxStandaloneBinding("session-a", "workspace-a"),
				sshHosts: [],
				requireInitialViewportFrame: true,
			});
			if (fixture.expected) {
				expect(attachment.startDelivery()).toMatchObject([
					{
						kind: "failure",
						reason: expect.stringMatching(fixture.expected),
					},
				]);
			} else {
				expect(attachment.startDelivery()).toMatchObject([
					{
						kind: "adapter",
						record: {
							kind: "control",
							body: {
								kind: "error",
								message: "exact initial Host control error",
							},
						},
					},
				]);
			}
		}
	});

	it("retires a delayed counted seed without publishing into its successor", async () => {
		let deliverFromCarrier!: (record: ArrayBuffer) => void;
		let current = true;
		mocks.attachLocal.mockImplementation(
			(request: { onRecord(record: ArrayBuffer): void }) => {
				deliverFromCarrier = request.onRecord;
				return Promise.resolve({
					...receipt,
					initialDeliveryRecordCount: 1,
				});
			},
		);
		const attaching = attachStructuredTerminalRecords({
			observerId: "observer-retired-delayed-seed",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
			requireInitialViewportFrame: true,
			isCurrent: () => current,
		});
		await vi.waitFor(() => expect(deliverFromCarrier).toBeTypeOf("function"));
		current = false;
		const seed = viewportFrameRecord(1n);
		deliverFromCarrier(seed.buffer as ArrayBuffer);

		await expect(attaching).rejects.toThrow(
			"structured_terminal_attach_retired",
		);
	});

	it("aborts a counted seed wait without waiting for the missing callback", async () => {
		const controller = new AbortController();
		mocks.attachLocal.mockResolvedValueOnce({
			...receipt,
			initialDeliveryRecordCount: 1,
		});
		const attaching = attachStructuredTerminalRecords({
			observerId: "observer-aborted-missing-seed",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
			requireInitialViewportFrame: true,
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(mocks.attachLocal).toHaveBeenCalledOnce());

		controller.abort();

		await expect(attaching).rejects.toThrow(
			"structured_terminal_attach_retired",
		);
	});

	it("preserves side-record order around one contiguous multipart frame", async () => {
		let deliverFromCarrier!: (record: ArrayBuffer) => void;
		let resolveAttach!: (value: typeof receipt) => void;
		mocks.attachLocal.mockImplementation(
			(request: { onRecord(record: ArrayBuffer): void }) =>
				new Promise<typeof receipt>((resolve) => {
					deliverFromCarrier = request.onRecord;
					resolveAttach = resolve;
				}),
		);
		const attaching = attachStructuredTerminalRecords({
			observerId: "observer-a",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
		});
		await vi.waitFor(() => expect(deliverFromCarrier).toBeTypeOf("function"));
		const first = viewportFrameRecord(1n);
		const before = bellEventRecord(1n, 1n);
		const multipart = multipartViewportFrameRecords(2n, 1n);
		const after = bellEventRecord(2n, 2n);
		const control = new TextEncoder().encode(
			JSON.stringify({ kind: "control", body: { kind: "exit" } }),
		);
		for (const record of [first, before, ...multipart, after, control]) {
			deliverFromCarrier(record.buffer as ArrayBuffer);
		}

		resolveAttach({ ...receipt, initialDeliveryRecordCount: 6 });
		const attachment = await attaching;
		const staged = attachment.startDelivery();
		expect(
			staged.map((record) =>
				record.kind === "terminal"
					? record.decoded.record.body.case
					: record.kind,
			),
		).toEqual(["viewportFrame", "event", "viewportFrame", "event", "adapter"]);
		expect(staged[staged.length - 1]).toMatchObject({
			kind: "adapter",
			record: { kind: "control", body: { kind: "exit" } },
		});
	});

	it("does not attach after its presentation generation retires", async () => {
		const binding = hmuxStandaloneBinding("session-a", "workspace-a");

		await expect(
			attachStructuredTerminalRecords({
				observerId: "observer-a",
				surfaceId: "surface-a",
				binding,
				sshHosts: [],
				prepareAttach: vi.fn().mockResolvedValue(undefined),
				isCurrent: () => false,
			}),
		).rejects.toThrow("structured_terminal_attach_retired");
		expect(mocks.attachLocal).not.toHaveBeenCalled();
		expect(mocks.attachRemote).not.toHaveBeenCalled();
	});

	it("does not publish a delayed receipt into a retired generation", async () => {
		let current = true;
		let resolveAttach!: (value: typeof receipt) => void;
		mocks.attachLocal.mockImplementation(
			() =>
				new Promise<typeof receipt>((resolve) => {
					resolveAttach = resolve;
				}),
		);
		const onAttachReceipt = vi.fn();
		const attaching = attachStructuredTerminalRecords({
			observerId: "observer-retired-receipt",
			surfaceId: "surface-a",
			binding: hmuxStandaloneBinding("session-a", "workspace-a"),
			sshHosts: [],
			isCurrent: () => current,
			onAttachReceipt,
		});
		await vi.waitFor(() => expect(mocks.attachLocal).toHaveBeenCalledOnce());

		current = false;
		let confirmDetach!: () => void;
		mocks.detach.mockReturnValueOnce(new Promise<void>((resolve) => {
			confirmDetach = resolve;
		}));
		let settled = false;
		void attaching.then(() => { settled = true; }, () => { settled = true; });
		resolveAttach(receipt);
		await vi.waitFor(() => {
			expect(mocks.detach).toHaveBeenCalledWith("observer-retired-receipt");
		});
		expect(settled).toBe(false);
		confirmDetach();

		await expect(attaching).rejects.toThrow(
			"structured_terminal_attach_retired",
		);
		expect(onAttachReceipt).not.toHaveBeenCalled();
	});

	it("does not open the obsolete endpoint after preparation replaced its binding", async () => {
		await expect(
			attachStructuredTerminalRecords({
				observerId: "observer-replaced",
				surfaceId: "surface-a",
				binding: hmuxStandaloneBinding("session-a", "workspace-a"),
				sshHosts: [],
				prepareAttach: vi.fn().mockResolvedValue({
					status: "attachment_retired",
					reason: "binding_replaced",
				}),
			}),
		).rejects.toMatchObject({
			code: "structured_terminal_attach_retired",
			reason: "binding_replaced",
		});
		expect(mocks.attachLocal).not.toHaveBeenCalled();
		expect(mocks.attachRemote).not.toHaveBeenCalled();
	});

	it("does not open a proven-absent endpoint after preparation retires its attachment", async () => {
		await expect(
			attachStructuredTerminalRecords({
				observerId: "observer-absent",
				surfaceId: "surface-a",
				binding: hmuxStandaloneBinding("session-a", "workspace-a"),
				sshHosts: [],
				prepareAttach: vi.fn().mockResolvedValue({
					status: "attachment_retired",
					reason: "source_absent",
				}),
			}),
		).rejects.toMatchObject({
			code: "structured_terminal_attach_retired",
			reason: "source_absent",
		});
		expect(mocks.attachLocal).not.toHaveBeenCalled();
		expect(mocks.attachRemote).not.toHaveBeenCalled();
	});

	it("changes only the SSH carrier while preserving the record surface", async () => {
		const binding = remoteHmuxStandaloneBinding(
			"session-r",
			"workspace-r",
			"host-r",
			"bridge-r",
		);
		const host = { id: "host-r" } as SshHostConfig;
		const target = { hostId: "host-r" };
		const session = {
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		};
		const onAttachReceipt = vi.fn();
		mocks.resolveRemote.mockResolvedValue({ target, session });
		await attachStructuredTerminalRecords({
			observerId: "observer-r",
			surfaceId: "surface-r",
			binding,
			sshHosts: [host],
			onAttachReceipt,
		});

		expect(mocks.resolveRemote).toHaveBeenCalledWith([host], binding);
		expect(mocks.attachRemote).toHaveBeenCalledWith({
			observerId: "observer-r",
			surfaceId: "surface-r",
			access: "writer",
			target,
			session,
			onRecord: expect.any(Function),
		});
		expect(onAttachReceipt.mock.calls[0]?.[0].backendCommandUs).toBeUndefined();
		expect(mocks.attachLocal).not.toHaveBeenCalled();
	});

	it("attaches only the exact managed Host generation", async () => {
		const fence = {
			runnerPrincipal: "principal-r",
			runnerInstance: "runner-r",
			channelEpoch: "7",
			hostInstanceId: "host-instance-r",
			terminalEpoch: "terminal-r",
		};
		const binding = remoteHmuxManagedBinding(
			"session-r",
			"workspace-r",
			"host-r",
			"bridge-r",
			"create-r",
			fence,
		);
		mocks.resolveRemote.mockResolvedValue({
			target: { hostId: "host-r" },
			session: {
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				sessionClass: "managed",
				...fence,
			},
		});

		await attachStructuredTerminalRecords({
			observerId: "observer-r",
			surfaceId: "surface-r",
			binding,
			sshHosts: [{ id: "host-r" } as SshHostConfig],
		});
		expect(mocks.attachRemote).toHaveBeenCalledOnce();

		mocks.attachRemote.mockClear();
		mocks.resolveRemote.mockResolvedValue({
			target: { hostId: "host-r" },
			session: {
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				sessionClass: "managed",
				...fence,
				terminalEpoch: "replacement-terminal",
			},
		});
		await expect(
			attachStructuredTerminalRecords({
				observerId: "observer-r",
				surfaceId: "surface-r",
				binding,
				sshHosts: [{ id: "host-r" } as SshHostConfig],
			}),
		).rejects.toThrow("remote_hmux_managed_attach_generation_changed");
		expect(mocks.attachRemote).not.toHaveBeenCalled();
	});
});
