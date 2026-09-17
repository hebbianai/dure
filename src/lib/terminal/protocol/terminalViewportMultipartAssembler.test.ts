import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
	BufferId,
	CellStyleSchema,
	CursorShape,
	CursorStateSchema,
	GraphemeSchema,
	InputModesSchema,
	MouseEncoding,
	MouseTrackingMode,
	RowTermination,
	TerminalColorOverridesSchema,
	TerminalRowSchema,
	type TerminalStateRecord,
	TerminalStateRecordSchema,
	TerminalTablesSchema,
	UnderlineKind,
	UnicodeWidthProfileSchema,
	ViewportAnchorStatus,
	ViewportFramePartSchema,
	ViewportFrameSchema,
} from "../../../contracts/terminalStateProtocol";
import {
	decodeTerminalStateRecord,
	encodeTerminalStateRecord,
	TERMINAL_STATE_MAX_VIEWPORT_FRAME_BYTES,
} from "./terminalStateProtocol";
import {
	createTerminalViewportMultipartAssembler,
	type TerminalViewportMultipartAssembly,
} from "./terminalViewportMultipartAssembler";

const validationMocks = vi.hoisted(() => ({ completeFrames: 0 }));

vi.mock("./terminalViewportValidation", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./terminalViewportValidation")>();
	return {
		...actual,
		validateTerminalViewportFrame: (
			...args: Parameters<typeof actual.validateTerminalViewportFrame>
		) => {
			validationMocks.completeFrames += 1;
			return actual.validateTerminalViewportFrame(...args);
		},
	};
});

const frame = create(ViewportFrameSchema, {
	projectionRevision: 2n,
	canonicalColumns: 1,
	viewportRows: 1,
	activeBuffer: BufferId.NORMAL,
	rows: [
		create(TerminalRowSchema, {
			rowId: 1n,
			logicalLineId: 1n,
			logicalCellSpan: 1,
			termination: RowTermination.HARD_BREAK,
			cells: [{ graphemeIndex: 0, styleIndex: 0 }],
		}),
	],
	tables: create(TerminalTablesSchema, {
		graphemes: [create(GraphemeSchema, { text: "x", displayWidth: 1 })],
		styles: [create(CellStyleSchema, { underline: UnderlineKind.NONE })],
	}),
	cursor: create(CursorStateSchema, {
		visible: true,
		shape: CursorShape.BLOCK,
	}),
	inputModes: create(InputModesSchema, {
		mouseTracking: MouseTrackingMode.NONE,
		mouseEncoding: MouseEncoding.DEFAULT,
	}),
	colorOverrides: create(TerminalColorOverridesSchema),
	unicodeWidth: create(UnicodeWidthProfileSchema, {
		unicodeVersion: "15.1.0",
		ambiguousWidth: 1,
		emojiWidth: 2,
	}),
	followTail: true,
	anchorStatus: ViewportAnchorStatus.FOLLOW_TAIL,
	rowsFromTail: 0n,
});

interface PartOverrides {
	readonly secondEpoch?: string;
	readonly secondBatch?: string;
	readonly secondRecordId?: bigint;
	readonly totalFrameBytes?: number;
}

function multipartRecords(overrides: PartOverrides = {}): Uint8Array[] {
	const frameBytes = toBinary(ViewportFrameSchema, frame);
	const split = Math.ceil(frameBytes.byteLength / 2);
	return [frameBytes.slice(0, split), frameBytes.slice(split)].map(
		(chunk, partIndex) =>
			encodeRaw(
				partIndex === 1 ? (overrides.secondRecordId ?? 101n) : 100n,
				create(TerminalStateRecordSchema, {
					schemaMinor: 5,
					terminalEpoch:
						partIndex === 1
							? (overrides.secondEpoch ?? "terminal-a")
							: "terminal-a",
					throughOutputSeq: 2n,
					stateRevision: 2n,
					body: {
						case: "viewportFramePart",
						value: create(ViewportFramePartSchema, {
							batchId: new TextEncoder().encode(
								partIndex === 1
									? (overrides.secondBatch ?? "batch-a")
									: "batch-a",
							),
							partIndex,
							partCount: 2,
							totalFrameBytes: overrides.totalFrameBytes ?? frameBytes.byteLength,
							frameChunk: chunk,
							projectionRevision: 2n,
						}),
					},
				}),
			),
	);
}

function encodeRaw(recordId: bigint, record: TerminalStateRecord): Uint8Array {
	const payload = toBinary(TerminalStateRecordSchema, record);
	const encoded = new Uint8Array(20 + payload.byteLength);
	encoded.set([0x54, 0x53, 0x50, 0x42, 1, 5, 12, 0]);
	const view = new DataView(encoded.buffer);
	view.setUint32(8, payload.byteLength, true);
	view.setBigUint64(12, recordId, true);
	encoded.set(payload, 20);
	return encoded;
}

function expectResync(result: TerminalViewportMultipartAssembly): void {
	expect(result.status).toBe("resync_required");
}

describe("terminal viewport multipart assembler", () => {
	it("copies multipart payload bytes into owned assembly storage only once", () => {
		const records = multipartRecords();
		const chunks = records.map((encoded) => {
			const { record } = decodeTerminalStateRecord(encoded);
			if (record.body.case !== "viewportFramePart") {
				throw new Error("expected a viewport frame part");
			}
			return record.body.value.frameChunk;
		});
		const frameByteLength = chunks.reduce(
			(total, chunk) => total + chunk.byteLength, 0,
		);
		// Track copies originating in frame chunks, excluding envelope, batch ID,
		// protobuf metadata, and decoded row storage.
		const isChunk = (bytes: Uint8Array) =>
			chunks.some((chunk) =>
				chunk.buffer === bytes.buffer &&
				chunk.byteOffset === bytes.byteOffset &&
				chunk.byteLength === bytes.byteLength,
			);
		let copiedBytes = 0;
		const originalSlice = Uint8Array.prototype.slice;
		const originalSet = Uint8Array.prototype.set;
		const slice = vi.spyOn(Uint8Array.prototype, "slice").mockImplementation(function (
			this: Uint8Array,
			start?: number,
			end?: number,
		) {
			const copied = originalSlice.call(this, start, end);
			if (isChunk(this)) {
				copiedBytes += copied.byteLength;
				chunks.push(copied);
			}
			return copied;
		});
		const set = vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (
			this: Uint8Array,
			source: ArrayLike<number>,
			offset?: number,
		) {
			if (source instanceof Uint8Array && isChunk(source)) {
				copiedBytes += source.byteLength;
			}
			originalSet.call(this, source, offset);
		});
		try {
			const assembler = createTerminalViewportMultipartAssembler();
			expect(records.map((record) => assembler.push(record).status)).toEqual([
				"pending",
				"complete",
			]);
			expect(copiedBytes).toBe(frameByteLength);
		} finally {
			set.mockRestore();
			slice.mockRestore();
		}
	});

	it("owns received bytes when the transport reuses its input buffer", () => {
		const assembler = createTerminalViewportMultipartAssembler();
		const [first, second] = multipartRecords();
		expect(assembler.push(first as Uint8Array).status).toBe("pending");
		first?.fill(0);
		const complete = assembler.push(second as Uint8Array);
		if (complete.status !== "complete") throw new Error("frame was incomplete");
		expect(complete.decoded.record.body).toEqual({
			case: "viewportFrame",
			value: frame,
		});
	});

	it.each([-1, 1])("rejects a total-size mismatch (%i bytes) and accepts a new batch", (delta) => {
		const assembler = createTerminalViewportMultipartAssembler();
		const [first, second] = multipartRecords({
			totalFrameBytes: toBinary(ViewportFrameSchema, frame).byteLength + delta,
		});
		expect(assembler.push(first as Uint8Array).status).toBe("pending");
		expectResync(assembler.push(second as Uint8Array));
		expect(assembler.hasIncomplete()).toBe(false);
		expect(multipartRecords().map((record) => assembler.push(record).status)).toEqual([
			"pending", "complete",
		]);
	});

	it.each([0, TERMINAL_STATE_MAX_VIEWPORT_FRAME_BYTES + 1])(
		"rejects an invalid frame allocation size (%i bytes) before assembly",
		(totalFrameBytes) => {
			const assembler = createTerminalViewportMultipartAssembler();
			const [first] = multipartRecords({ totalFrameBytes });
			expectResync(assembler.push(first as Uint8Array));
			expect(assembler.hasIncomplete()).toBe(false);
		},
	);

	it("discards incomplete bytes on cancellation or a duplicate and accepts a new batch", () => {
		const assembler = createTerminalViewportMultipartAssembler();
		const [first, second] = multipartRecords();
		expect(assembler.push(first as Uint8Array).status).toBe("pending");
		expect(assembler.discardIncomplete()).toBe(true);
		expect(assembler.discardIncomplete()).toBe(false);
		expectResync(assembler.push(second as Uint8Array));
		expect(assembler.push(first as Uint8Array).status).toBe("pending");
		expectResync(assembler.push(first as Uint8Array));
		expect(assembler.hasIncomplete()).toBe(false);
		expect(assembler.push(first as Uint8Array).status).toBe("pending");
		expect(assembler.push(second as Uint8Array).status).toBe("complete");
	});

	it("reuses a byte-identical complete row while advancing frame authority", () => {
		const assembler = createTerminalViewportMultipartAssembler();
		const direct = (recordId: bigint, revision: bigint) =>
			encodeTerminalStateRecord(
				recordId,
				create(TerminalStateRecordSchema, {
					schemaMinor: 4,
					terminalEpoch: "terminal-a",
					throughOutputSeq: revision,
					stateRevision: revision,
					body: {
						case: "viewportFrame",
						value: create(ViewportFrameSchema, {
							...frame,
							projectionRevision: revision,
						}),
					},
				}),
			);
		const first = assembler.push(direct(1n, 2n));
		const second = assembler.push(direct(2n, 3n));
		if (first.status !== "downstream" || second.status !== "downstream") {
			throw new Error("direct complete frames were not delivered");
		}
		if (
			first.decoded.record.body.case !== "viewportFrame" ||
			second.decoded.record.body.case !== "viewportFrame"
		) {
			throw new Error("direct records were not viewport frames");
		}

		expect(second.decoded.record.body.value.projectionRevision).toBe(3n);
		expect(second.decoded.record.body.value.rows[0]).toBe(
			first.decoded.record.body.value.rows[0],
		);
	});

	it("reuses an exact physical row after it moves within the viewport", () => {
		const assembler = createTerminalViewportMultipartAssembler();
		const row = (rowId: bigint) =>
			create(TerminalRowSchema, {
				rowId,
				logicalLineId: rowId,
				logicalCellSpan: 1,
				termination: RowTermination.HARD_BREAK,
				cells: [{ graphemeIndex: 0, styleIndex: 0 }],
			});
		const direct = (recordId: bigint, rowIds: readonly bigint[]) =>
			assembler.push(
				encodeTerminalStateRecord(
					recordId,
					create(TerminalStateRecordSchema, {
						schemaMinor: 4,
						terminalEpoch: "terminal-a",
						throughOutputSeq: recordId,
						stateRevision: recordId,
						body: {
							case: "viewportFrame",
							value: create(ViewportFrameSchema, {
								...frame,
								projectionRevision: recordId,
								viewportRows: 2,
								rows: rowIds.map(row),
							}),
						},
					}),
				),
			);
		const first = direct(1n, [1n, 2n]);
		const second = direct(2n, [2n, 3n]);
		if (
			first.status !== "downstream" ||
			second.status !== "downstream" ||
			first.decoded.record.body.case !== "viewportFrame" ||
			second.decoded.record.body.case !== "viewportFrame"
		) {
			throw new Error("scrolling direct frames were not delivered");
		}

		expect(second.decoded.record.body.value.rows[0]).toBe(
			first.decoded.record.body.value.rows[1],
		);
		expect(second.decoded.record.body.value.rows[1]).not.toBe(
			first.decoded.record.body.value.rows[0],
		);
	});

	it("shares exact row reuse between direct and multipart complete frames", () => {
		const assembler = createTerminalViewportMultipartAssembler();
		const direct = assembler.push(
			encodeTerminalStateRecord(
				1n,
				create(TerminalStateRecordSchema, {
					schemaMinor: 4,
					terminalEpoch: "terminal-a",
					throughOutputSeq: 1n,
					stateRevision: 1n,
					body: {
						case: "viewportFrame",
						value: create(ViewportFrameSchema, {
							...frame,
							projectionRevision: 1n,
						}),
					},
				}),
			),
		);
		if (
			direct.status !== "downstream" ||
			direct.decoded.record.body.case !== "viewportFrame"
		) {
			throw new Error("direct seed frame was not delivered");
		}
		const directRow = direct.decoded.record.body.value.rows[0];
		const [firstPart, secondPart] = multipartRecords();
		expect(assembler.push(firstPart as Uint8Array).status).toBe("pending");
		const complete = assembler.push(secondPart as Uint8Array);
		if (
			complete.status !== "complete" ||
			complete.decoded.record.body.case !== "viewportFrame"
		) {
			throw new Error("multipart successor frame was not delivered");
		}

		expect(complete.decoded.record.body.value.rows[0]).toBe(directRow);
	});

	it("publishes only the complete latest viewport frame", () => {
		expect(frame.rowsFromTail).toBe(0n);
		const assembler = createTerminalViewportMultipartAssembler();
		const [first, second] = multipartRecords();

		expect(assembler.push(first as Uint8Array)).toEqual({ status: "pending" });
		expect(assembler.hasIncomplete()).toBe(true);
		const complete = assembler.push(second as Uint8Array);

		if (complete.status !== "complete") {
			throw new Error(
				complete.status === "resync_required"
					? complete.reason
					: "frame was incomplete",
			);
		}
		expect(complete.decoded.record.body.case).toBe("viewportFrame");
		expect(complete.decoded.metadata.recordId).toBe(101n);
		expect(assembler.hasIncomplete()).toBe(false);
	});

	it("semantically validates one reassembled complete frame exactly once", () => {
		const assembler = createTerminalViewportMultipartAssembler();
		const [first, second] = multipartRecords();
		validationMocks.completeFrames = 0;

		expect(assembler.push(first as Uint8Array).status).toBe("pending");
		expect(assembler.push(second as Uint8Array).status).toBe("complete");
		expect(validationMocks.completeFrames).toBe(1);
	});

	it("rejects reordered and mixed multipart identities", () => {
		const [, reordered] = multipartRecords();
		expectResync(
			createTerminalViewportMultipartAssembler().push(reordered as Uint8Array),
		);

		for (const overrides of [
			{ secondEpoch: "terminal-b" },
			{ secondBatch: "batch-b" },
			{ secondRecordId: 102n },
		] satisfies PartOverrides[]) {
			const assembler = createTerminalViewportMultipartAssembler();
			const [first, second] = multipartRecords(overrides);
			expect(assembler.push(first as Uint8Array).status).toBe("pending");
			expectResync(assembler.push(second as Uint8Array));
		}

		const interrupted = createTerminalViewportMultipartAssembler();
		const [first] = multipartRecords();
		expect(interrupted.push(first as Uint8Array).status).toBe("pending");
		const direct = encodeTerminalStateRecord(
			200n,
			create(TerminalStateRecordSchema, {
				schemaMinor: 4,
				terminalEpoch: "terminal-a",
				throughOutputSeq: 2n,
				stateRevision: 2n,
				body: { case: "viewportFrame", value: frame },
			}),
		);
		expectResync(interrupted.push(direct));
	});
});
