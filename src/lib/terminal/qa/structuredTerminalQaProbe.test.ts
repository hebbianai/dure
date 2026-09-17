import { describe, expect, test, vi } from "vitest";
import type { TerminalQaBufferState } from "@/lib/terminal/terminalViewContracts";
import type {
	TerminalQaInputReceipt,
	TerminalWindowFocusProbeSurface,
} from "@/lib/terminal/terminalWindowFocusProbe";
import {
	StructuredTerminalQaProbe,
	type StructuredTerminalQaProbeLifecycle,
} from "./structuredTerminalQaProbe";

function bufferState(markerPresent = false): TerminalQaBufferState {
	return {
		columns: 80,
		rows: 24,
		fitColumns: 80,
		fitRows: 24,
		fitDimensionsMatch: true,
		viewportFill: {
			containerHeight: 384,
			gridHeight: 384,
			effectiveGridHeight: 384,
			rowHeight: 16,
			unfilledHeight: 0,
			overflowHeight: 0,
			fillsContainer: true,
		},
		bufferLength: 24,
		scrollbackRows: 0,
		viewportY: 0,
		atBottom: true,
		concealed: false,
		logicalScrollbackMarkerPresent: markerPresent,
		resizeRenderSeedVisible: false,
	};
}

function lifecycle(): StructuredTerminalQaProbeLifecycle {
	return {
		onConnected: vi.fn(() => vi.fn()),
		onFocused: vi.fn(),
		onHydrationChange: vi.fn(),
		onSynchronized: vi.fn(),
		onPresented: vi.fn(),
		onError: vi.fn(),
	};
}

function deferredReceipt() {
	let resolve!: (receipt: TerminalQaInputReceipt) => void;
	const promise = new Promise<TerminalQaInputReceipt>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function connectedFixture(id: string, timeoutMs = 1_000) {
	const marker = `HMUX_WINDOW_QA_ABCDEF123456_B_${id.padStart(4, "0")}`;
	const attachmentId = `attachment-${id}`;
	const receipt = deferredReceipt();
	const events = lifecycle();
	let painted = false;
	const surface: TerminalWindowFocusProbeSurface = {
		focus: vi.fn(async () => {}),
		releaseKeyboardControl: vi.fn(async () => {}),
		writeMarker: vi.fn(() => receipt.promise),
		scrollRows: vi.fn(() => 1n),
		markerCounts: vi.fn(() => (painted ? { [marker]: 1 } : {})),
		projectionMarkerCounts: vi.fn(() => (painted ? { [marker]: 1 } : {})),
		bufferState: vi.fn((candidate?: string) =>
			bufferState(painted && candidate === marker),
		),
		renderMetrics: vi.fn(() => ({
			queuedWrites: 0,
			queuedBytes: 0,
			activeBytes: 0,
			activeWriteAgeMs: null,
			completedWrites: 1,
			snapshotCollapses: 0,
			maxWriteLatencyMs: 1,
		})),
	};
	const probe = new StructuredTerminalQaProbe(id, events, timeoutMs);
	probe.connect(surface);
	probe.onSurfaceAttachmentStarted(attachmentId);
	probe.onHydrationChange(false);
	probe.onSynchronized();
	probe.onPresented(bufferState());
	return {
		attachmentId,
		events,
		marker,
		probe,
		receipt,
		surface,
		paint: () => {
			painted = true;
			probe.onPresented(bufferState(true));
		},
	};
}

function resolveWritten(
	fixture: ReturnType<typeof connectedFixture>,
	requestId: string,
) {
	fixture.receipt.resolve({
		requestId,
		attachmentIdentity: `attachment:${requestId}`,
		state: "written_to_pty",
		inputStartedAtMs: 1,
		hostReceiptAtMs: 2,
	});
}

describe("StructuredTerminalQaProbe", () => {
	test("tracks attachment lifetime independently from probe connection", () => {
		const probe = new StructuredTerminalQaProbe(
			"surface-attachment",
			lifecycle(),
		);

		expect(probe.hasSurfaceAttachment).toBe(false);
		probe.onSurfaceAttachmentStarted("attachment-without-connection");
		expect(probe.hasSurfaceAttachment).toBe(true);
		probe.dispose();
		expect(probe.hasSurfaceAttachment).toBe(false);
	});

	test("correlates one Host receipt with one painted and projected marker", async () => {
		const fixtures = Array.from({ length: 16 }, (_, index) =>
			connectedFixture(String(index + 1)),
		);
		await Promise.all(fixtures.map(({ probe }) => probe.focus()));
		const observations = fixtures.map(({ marker, probe }) =>
			probe.observeInput(marker, marker, {
				onReceipt: vi.fn(),
				onProjection: vi.fn(),
			}),
		);
		for (const [index, fixture] of fixtures.entries()) {
			expect(fixture.surface.focus).toHaveBeenCalledOnce();
			expect(fixture.surface.writeMarker).toHaveBeenCalledWith(
				fixture.marker,
				fixture.marker,
			);
			resolveWritten(fixture, String(index + 1));
			fixture.paint();
		}

		for (const observation of await Promise.all(observations)) {
			expect(observation.receipt.state).toBe("written_to_pty");
			expect(observation.projection.logicalScrollbackMarkerPresent).toBe(true);
			expect(observation.markerCounts).toEqual({ painted: 1, projection: 1 });
		}
	});

	test("waits for both paint and its Host receipt", async () => {
		const fixture = connectedFixture("17");
		let completed = false;
		const observation = fixture.probe
			.observeInput(fixture.marker, fixture.marker, {
				onReceipt: vi.fn(),
				onProjection: vi.fn(),
			})
			.then(() => {
				completed = true;
			});
		fixture.paint();
		await Promise.resolve();
		expect(completed).toBe(false);

		resolveWritten(fixture, "17");
		await observation;
		expect(completed).toBe(true);
	});

	test("awaits the transport's exact surface retirement promise", async () => {
		const fixture = connectedFixture("25");
		let retire!: () => void;
		const retirement = new Promise<void>((resolve) => {
			retire = resolve;
		});
		let completed = false;
		const waiting = fixture.probe.waitForSurfaceRetirement().then(() => {
			completed = true;
		});
		fixture.probe.onSurfaceRetirement(fixture.attachmentId, retirement);
		await Promise.resolve();
		expect(completed).toBe(false);

		retire();
		await waiting;
		expect(completed).toBe(true);
	});

	test("retains the current attachment retirement until cleanup waits", async () => {
		const fixture = connectedFixture("27");
		const retirement = Promise.resolve();
		fixture.probe.onSurfaceRetirement(fixture.attachmentId, retirement);

		await expect(
			fixture.probe.waitForSurfaceRetirement(),
		).resolves.toBeUndefined();
	});

	test("does not reuse a retired attachment for later cleanup", async () => {
		const fixture = connectedFixture("26", 10);
		const nextAttachmentId = "attachment-26-next";
		fixture.probe.onSurfaceAttachmentStarted(nextAttachmentId);
		fixture.probe.onHydrationChange(true);
		fixture.probe.onHydrationChange(false);
		fixture.probe.onSynchronized();
		fixture.probe.onPresented(bufferState());
		fixture.probe.onSurfaceRetirement(fixture.attachmentId, Promise.resolve());
		await Promise.resolve();
		let retire!: () => void;
		const retirement = new Promise<void>((resolve) => {
			retire = resolve;
		});

		const waiting = fixture.probe.waitForSurfaceRetirement();
		fixture.probe.onSurfaceRetirement(nextAttachmentId, retirement);
		retire();

		await expect(waiting).resolves.toBeUndefined();
	});

	test("follows a replacement attachment without hiding predecessor failure", async () => {
		const fixture = connectedFixture("28");
		let completed = false;
		const waiting = fixture.probe.waitForSurfaceRetirement();
		const observed = waiting.then(
			() => {
				completed = true;
			},
			() => {
				completed = true;
			},
		);
		const nextAttachmentId = "attachment-28-next";
		fixture.probe.onSurfaceAttachmentStarted(nextAttachmentId);
		fixture.probe.onSurfaceRetirement(
			fixture.attachmentId,
			Promise.reject(new Error("predecessor detach failed")),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(completed).toBe(false);
		expect(fixture.events.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "predecessor detach failed" }),
		);

		fixture.probe.onSurfaceRetirement(nextAttachmentId, Promise.resolve());
		await expect(waiting).rejects.toThrow("predecessor detach failed");
		await observed;
		expect(completed).toBe(true);
	});

	test("drains a predecessor retirement before replacement cleanup can finish", async () => {
		const fixture = connectedFixture("29");
		let rejectPredecessor!: (error: Error) => void;
		const predecessorRetirement = new Promise<void>((_resolve, reject) => {
			rejectPredecessor = reject;
		});
		fixture.probe.onSurfaceRetirement(
			fixture.attachmentId,
			predecessorRetirement,
		);

		const replacementAttachmentId = "attachment-29-next";
		fixture.probe.onSurfaceAttachmentStarted(replacementAttachmentId);
		let completed = false;
		const waiting = fixture.probe.waitForSurfaceRetirement();
		const observed = waiting.then(
			() => {
				completed = true;
			},
			() => {
				completed = true;
			},
		);
		fixture.probe.onSurfaceRetirement(
			replacementAttachmentId,
			Promise.resolve(),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(completed).toBe(false);
		rejectPredecessor(new Error("predecessor detach failed late"));
		await expect(waiting).rejects.toThrow("predecessor detach failed late");
		await observed;
		expect(fixture.events.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "predecessor detach failed late" }),
		);
	});

	test("requires fresh readiness after a surface reconnect", () => {
		const fixture = connectedFixture("20");

		fixture.probe.connect(fixture.surface);
		expect(fixture.probe.connected).toBe(false);

		fixture.probe.onSurfaceAttachmentStarted("attachment-20-next");
		fixture.probe.onHydrationChange(false);
		fixture.probe.onSynchronized();
		expect(fixture.probe.connected).toBe(false);

		fixture.probe.onPresented(bufferState());
		expect(fixture.probe.connected).toBe(true);
	});

	test("does not project focus from a retired surface", async () => {
		const fixture = connectedFixture("23");
		let completeFocus!: () => void;
		vi.mocked(fixture.surface.focus).mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					completeFocus = resolve;
				}),
		);
		const focus = fixture.probe.focus();

		fixture.probe.connect(fixture.surface);
		completeFocus();

		await expect(focus).rejects.toThrow(
			"structured terminal QA surface changed during focus",
		);
		expect(fixture.events.onFocused).not.toHaveBeenCalled();
	});

	test("bounds a lost Host focus receipt", async () => {
		const fixture = connectedFixture("24", 10);
		vi.mocked(fixture.surface.focus).mockImplementation(
			() => new Promise<void>(() => {}),
		);
		const outcome = await Promise.race([
			fixture.probe.focus().then(
				() => "resolved",
				(error) => (error instanceof Error ? error.message : String(error)),
			),
			new Promise<string>((resolve) =>
				setTimeout(() => resolve("test deadline expired"), 50),
			),
		]);

		expect(outcome).toContain(
			"timed out waiting for structured terminal focus",
		);
		expect(fixture.events.onFocused).not.toHaveBeenCalled();
	});

	test("requires a fresh presentation after attachment rehydration", () => {
		const fixture = connectedFixture("21");

		fixture.probe.onSurfaceAttachmentStarted("attachment-21-next");
		fixture.probe.onHydrationChange(true);
		fixture.probe.onHydrationChange(false);
		fixture.probe.onSynchronized();
		expect(fixture.probe.connected).toBe(false);

		fixture.probe.onPresented(bufferState());
		expect(fixture.probe.connected).toBe(true);
	});

	test("retires a paint-first observation when its surface reconnects", async () => {
		const fixture = connectedFixture("22");
		const onReceipt = vi.fn();
		const observation = fixture.probe.observeInput(
			fixture.marker,
			fixture.marker,
			{ onReceipt, onProjection: vi.fn() },
		);
		fixture.paint();
		fixture.probe.connect(fixture.surface);
		resolveWritten(fixture, "22");

		await expect(observation).rejects.toThrow(
			"structured terminal QA surface replaced",
		);
		expect(onReceipt).not.toHaveBeenCalled();
	});

	test("times out when paint arrives without a Host receipt", async () => {
		const fixture = connectedFixture("18", 10);
		const observation = fixture.probe.observeInput(
			fixture.marker,
			fixture.marker,
			{ onReceipt: vi.fn(), onProjection: vi.fn() },
		);
		fixture.paint();
		await expect(observation).rejects.toThrow(
			"timed out waiting for structured terminal receipt and projection",
		);
	});

	test("retires pending work and ignores lifecycle callbacks after dispose", async () => {
		const fixture = connectedFixture("19");
		const release = vi.mocked(fixture.events.onConnected).mock.results[0]
			?.value;
		const observation = fixture.probe.observeInput(
			fixture.marker,
			fixture.marker,
			{ onReceipt: vi.fn(), onProjection: vi.fn() },
		);
		fixture.probe.dispose();
		fixture.probe.dispose();
		fixture.probe.connect(fixture.surface);
		fixture.probe.onSurfaceAttachmentStarted("attachment-19-late");
		fixture.probe.onHydrationChange(true);
		fixture.probe.onSynchronized();
		fixture.probe.onPresented(bufferState());
		fixture.probe.onError(new Error("late"));

		await expect(observation).rejects.toThrow(
			"structured terminal QA probe disposed",
		);
		expect(fixture.events.onError).not.toHaveBeenCalled();
		expect(fixture.events.onPresented).toHaveBeenCalledOnce();
		expect(fixture.events.onSynchronized).toHaveBeenCalledOnce();
		expect(fixture.events.onHydrationChange).toHaveBeenCalledOnce();
		expect(fixture.events.onConnected).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
	});
});
