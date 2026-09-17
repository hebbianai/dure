/**
 * Shared builders for terminal state-protocol records used across terminal
 * test suites (structured view, record adapter, state protocol).
 *
 * Before this module, five suites each hand-rolled their own
 * `TerminalStateRecordSchema` scaffolding; a protocol field addition meant
 * touching every copy. Builders here construct *valid* records — suites that
 * probe malformed or truncated payloads keep those bespoke fixtures local.
 */
import { create, toBinary } from "@bufbuild/protobuf";
import {
	BellEventSchema,
	BufferId,
	CellStyleSchema,
	ClipboardFormat,
	ClipboardWriteRequestEventSchema,
	ColorKind,
	CursorShape,
	CursorStateSchema,
	ExecutionMarkerEventSchema,
	GraphemeSchema,
	InputModesSchema,
	InputOutputTimingSchema,
	InputReceiptSchema,
	InputRefusalReason,
	InputRefusedSchema,
	InputWrittenToPtySchema,
	MarkerKind,
	MouseEncoding,
	MouseTrackingMode,
	ResizeAppliedToTerminalSchema,
	ResizeFailedSchema,
	ResizeFailureReason,
	ResizeReceiptSchema,
	ResizeRefusalReason,
	ResizeRefusedSchema,
	RowTermination,
	TerminalColorOverridesSchema,
	TerminalColorSchema,
	TerminalEventSchema,
	TerminalRowSchema,
	TerminalStateRecordSchema,
	TerminalTablesSchema,
	UnderlineKind,
	UnicodeWidthProfileSchema,
	ViewportAnchorStatus,
	ViewportFramePartSchema,
	ViewportFrameSchema,
	WheelAppliedToViewportSchema,
	WheelFailedSchema,
	WheelFailureReason,
	WheelReceiptSchema,
	WheelRefusalReason,
	WheelRefusedSchema,
} from "@/contracts/terminalStateProtocol";
import type { HmuxStructuredTerminalRetryDirective } from "@/lib/hmux/failure/structuredTerminalAttachFailure";
import {
	decodeTerminalStateRecord,
	encodeTerminalStateRecord,
} from "@/lib/terminal/protocol/terminalStateProtocol";
import type { HmuxPaneBindingV1 } from "@/lib/terminal/terminalBinding";

export const DEFAULT_TERMINAL_EPOCH = "terminal-a";

/** A local hmux pane binding with test-friendly defaults. */
export function hmuxPaneBinding(sessionId: string): HmuxPaneBindingV1 {
	return {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		source: "local",
		hostId: "local",
		sessionId,
		workspaceId: "workspace-a",
	};
}

export interface ViewportFrameRecordOptions {
	readonly terminalEpoch?: string;
	readonly title?: string;
	readonly projectionRevision?: bigint;
	readonly appliedIntentSeq?: bigint;
	readonly stateRevision?: bigint;
	readonly throughOutputSeq?: bigint;
	readonly throughEventId?: bigint;
	readonly texts?: readonly string[];
	readonly columns?: number;
	readonly cursorColumn?: number;
	readonly cursorRow?: number;
	readonly mouseTracking?: MouseTrackingMode;
	readonly synchronizedOutput?: boolean;
	readonly activeBuffer?: BufferId;
	readonly hasMoreBefore?: boolean;
	readonly hasMoreAfter?: boolean;
	readonly followTail?: boolean;
	/** Explicit undefined models an unknown distance; omission keeps the default. */
	readonly rowsFromTail?: bigint;
	readonly splitTextIntoGraphemes?: boolean;
	readonly rowTerminations?: readonly RowTermination[];
	readonly logicalLineIds?: readonly bigint[];
	readonly damageBaseProjectionRevision?: bigint;
	readonly changedRowIndices?: readonly number[];
	readonly cellForegroundRgb?: number;
	readonly cellBackgroundRgb?: number;
	readonly inputOutputTiming?: {
		readonly inputBaselineOutputSequence: bigint;
		readonly firstOutputSequence: bigint;
		readonly inputToOutputMicros: bigint;
		readonly outputToProjectionStartMicros: bigint;
		readonly inputRecordId: bigint;
	};
}

function rgbTerminalColor(rgb: number | undefined) {
	return rgb === undefined
		? undefined
		: create(TerminalColorSchema, { kind: ColorKind.RGB, value: rgb });
}

/**
 * Encodes a complete viewport-frame record. One text entry per visible row;
 * every grapheme gets display width 1, so column math stays predictable.
 */
export function viewportFrameRecord(
	options: ViewportFrameRecordOptions = {},
): Uint8Array {
	const projectionRevision = options.projectionRevision ?? 1n;
	const texts = options.texts ?? ["x"];
	const followTail = options.followTail ?? true;
	const rowGraphemes = texts.map((text) =>
		options.splitTextIntoGraphemes === false ? [text] : Array.from(text),
	);
	const hasCellColor =
		options.cellForegroundRgb !== undefined ||
		options.cellBackgroundRgb !== undefined;
	const graphemeTexts = rowGraphemes.flat();
	const tables = create(TerminalTablesSchema, {
		// A complete blank grid still carries the protocol's nonempty table
		// authority; no row cell references this zero-width sentinel.
		graphemes:
			graphemeTexts.length > 0
				? graphemeTexts.map((text) =>
						create(GraphemeSchema, { text, displayWidth: 1 }),
					)
				: [create(GraphemeSchema, { text: "", displayWidth: 0 })],
		styles: [
			create(CellStyleSchema, { underline: UnderlineKind.NONE }),
			...(hasCellColor
				? [
						create(CellStyleSchema, {
							foreground: rgbTerminalColor(options.cellForegroundRgb),
							background: rgbTerminalColor(options.cellBackgroundRgb),
							underline: UnderlineKind.NONE,
						}),
					]
				: []),
		],
	});
	let graphemeIndex = 0;
	let previousLogicalLineId: bigint | undefined;
	let previousLogicalCellEnd = 0;
	let previousTermination = RowTermination.HARD_BREAK;
	const rows = rowGraphemes.map((graphemes, index) => {
		const cells = graphemes.map(() => ({
			graphemeIndex: graphemeIndex++,
			styleIndex: hasCellColor ? 1 : 0,
		}));
		const logicalLineId =
			options.logicalLineIds?.[index] ??
			projectionRevision * 100n + BigInt(index + 1);
		const continuesFromPrevious =
			previousLogicalLineId === logicalLineId &&
			previousTermination === RowTermination.SOFT_WRAP;
		const logicalCellOffset = continuesFromPrevious
			? previousLogicalCellEnd
			: 0;
		const termination =
			options.rowTerminations?.[index] ?? RowTermination.HARD_BREAK;
		previousLogicalLineId = logicalLineId;
		previousLogicalCellEnd = logicalCellOffset + cells.length;
		previousTermination = termination;
		return create(TerminalRowSchema, {
			rowId: projectionRevision * 100n + BigInt(index + 1),
			logicalLineId,
			logicalCellOffset,
			logicalCellSpan: cells.length,
			termination,
			continuesFromPrevious,
			cells,
		});
	});
	const record = create(TerminalStateRecordSchema, {
		schemaMinor: 3,
		terminalEpoch: options.terminalEpoch ?? DEFAULT_TERMINAL_EPOCH,
		throughOutputSeq:
			options.throughOutputSeq ?? options.stateRevision ?? projectionRevision,
		stateRevision: options.stateRevision ?? projectionRevision,
		body: {
			case: "viewportFrame",
			value: create(ViewportFrameSchema, {
				title: options.title ?? "",
				projectionRevision,
				damageBaseProjectionRevision:
					options.damageBaseProjectionRevision ?? 0n,
				canonicalColumns: options.columns ?? 80,
				viewportRows: Math.max(1, rows.length),
				activeBuffer: options.activeBuffer ?? BufferId.NORMAL,
				rows,
				tables,
				cursor: create(CursorStateSchema, {
					row: options.cursorRow ?? Math.max(0, rows.length - 1),
					column: options.cursorColumn ?? 0,
					visible: true,
					shape: CursorShape.BLOCK,
				}),
				inputModes: create(InputModesSchema, {
					mouseTracking: options.mouseTracking ?? MouseTrackingMode.NONE,
					mouseEncoding: MouseEncoding.DEFAULT,
					synchronizedOutput: options.synchronizedOutput ?? false,
				}),
				colorOverrides: create(TerminalColorOverridesSchema),
				unicodeWidth: create(UnicodeWidthProfileSchema, {
					unicodeVersion: "15.1.0",
					ambiguousWidth: 1,
					emojiWidth: 2,
				}),
				throughEventId: options.throughEventId ?? 0n,
				followTail,
				hasMoreBefore: options.hasMoreBefore ?? false,
				hasMoreAfter: options.hasMoreAfter ?? false,
				appliedIntentSeq: options.appliedIntentSeq ?? 0n,
				anchorStatus: followTail
					? ViewportAnchorStatus.FOLLOW_TAIL
					: ViewportAnchorStatus.ANCHORED,
				rowsFromTail: "rowsFromTail" in options
					? options.rowsFromTail
					: (followTail ? 0n : 1n),
				changedRowIndices: [...(options.changedRowIndices ?? [])],
				inputOutputTiming: options.inputOutputTiming
					? create(InputOutputTimingSchema, options.inputOutputTiming)
					: undefined,
			}),
		},
	});
	return encodeTerminalStateRecord(projectionRevision, record);
}

/**
 * Splits an encoded viewport-frame record into `partCount` multipart carrier
 * records, the way hosts chunk oversized frames.
 */
export function viewportFramePartRecords(
	encodedFrame: Uint8Array,
	options: {
		readonly partCount?: number;
		readonly terminalEpoch?: string;
	} = {},
): readonly Uint8Array[] {
	const partCount = options.partCount ?? 2;
	const decoded = decodeTerminalStateRecord(encodedFrame);
	if (decoded.record.body.case !== "viewportFrame") {
		throw new Error("viewport frame fixture is invalid");
	}
	const revision = decoded.record.body.value.projectionRevision;
	const frameBytes = toBinary(ViewportFrameSchema, decoded.record.body.value);
	const chunkSize = Math.ceil(frameBytes.byteLength / partCount);
	const chunks: Uint8Array[] = [];
	for (let index = 0; index < partCount; index += 1) {
		chunks.push(frameBytes.slice(index * chunkSize, (index + 1) * chunkSize));
	}
	return chunks.map((chunk, partIndex) =>
		encodeTerminalStateRecord(
			revision * 10n + BigInt(partIndex),
			create(TerminalStateRecordSchema, {
				schemaMinor: 5,
				terminalEpoch: options.terminalEpoch ?? decoded.record.terminalEpoch,
				throughOutputSeq: revision,
				stateRevision: revision,
				body: {
					case: "viewportFramePart",
					value: create(ViewportFramePartSchema, {
						batchId: new TextEncoder().encode(`batch-${revision}`),
						partIndex,
						partCount,
						totalFrameBytes: frameBytes.byteLength,
						frameChunk: chunk,
						projectionRevision: revision,
					}),
				},
			}),
		),
	);
}

export function inputReceiptRecord(
	inReplyToRecordId: bigint,
	terminalEpoch = DEFAULT_TERMINAL_EPOCH,
	inputBaselineOutputSequence?: bigint,
): Uint8Array {
	return encodeTerminalStateRecord(
		900n,
		create(TerminalStateRecordSchema, {
			schemaMinor: 4,
			terminalEpoch,
			throughOutputSeq: inputBaselineOutputSequence ?? 0n,
			stateRevision: 1n,
			body: {
				case: "inputReceipt",
				value: create(InputReceiptSchema, {
					inReplyToRecordId,
					outcome: {
						case: "writtenToPty",
						value: create(InputWrittenToPtySchema, {
							inputBaselineOutputSequence,
						}),
					},
				}),
			},
		}),
	);
}

export function inputRefusedReceiptRecord(
	inReplyToRecordId: bigint,
	terminalEpoch = DEFAULT_TERMINAL_EPOCH,
): Uint8Array {
	return encodeTerminalStateRecord(
		901n,
		create(TerminalStateRecordSchema, {
			schemaMinor: 4,
			terminalEpoch,
			throughOutputSeq: 0n,
			stateRevision: 1n,
			body: {
				case: "inputReceipt",
				value: create(InputReceiptSchema, {
					inReplyToRecordId,
					outcome: {
						case: "refused",
						value: create(InputRefusedSchema, {
							reason: InputRefusalReason.HOST_EXITING,
						}),
					},
				}),
			},
		}),
	);
}

export function resizeFailureReceiptRecord(
	inReplyToRecordId: bigint,
	terminalEpoch = DEFAULT_TERMINAL_EPOCH,
): Uint8Array {
	return encodeTerminalStateRecord(
		901n,
		create(TerminalStateRecordSchema, {
			schemaMinor: 4,
			terminalEpoch,
			throughOutputSeq: 0n,
			stateRevision: 1n,
			body: {
				case: "resizeReceipt",
				value: create(ResizeReceiptSchema, {
					inReplyToRecordId,
					outcome: {
						case: "failed",
						value: create(ResizeFailedSchema, {
							reason: ResizeFailureReason.PLATFORM_RESIZE_FAILED,
						}),
					},
				}),
			},
		}),
	);
}

export function resizeAppliedReceiptRecord(
	inReplyToRecordId: bigint,
	columns: number,
	rows: number,
	terminalEpoch = DEFAULT_TERMINAL_EPOCH,
): Uint8Array {
	return encodeTerminalStateRecord(
		903n,
		create(TerminalStateRecordSchema, {
			schemaMinor: 4,
			terminalEpoch,
			throughOutputSeq: 0n,
			stateRevision: 1n,
			body: {
				case: "resizeReceipt",
				value: create(ResizeReceiptSchema, {
					inReplyToRecordId,
					outcome: {
						case: "appliedToTerminal",
						value: create(ResizeAppliedToTerminalSchema, { columns, rows }),
					},
				}),
			},
		}),
	);
}

export function resizeRefusedReceiptRecord(
	inReplyToRecordId: bigint,
	reason: ResizeRefusalReason,
	terminalEpoch = DEFAULT_TERMINAL_EPOCH,
): Uint8Array {
	return encodeTerminalStateRecord(
		902n,
		create(TerminalStateRecordSchema, {
			schemaMinor: 4,
			terminalEpoch,
			throughOutputSeq: 0n,
			stateRevision: 1n,
			body: {
				case: "resizeReceipt",
				value: create(ResizeReceiptSchema, {
					inReplyToRecordId,
					outcome: {
						case: "refused",
						value: create(ResizeRefusedSchema, { reason }),
					},
				}),
			},
		}),
	);
}

export function resizeHostExitingReceiptRecord(
	inReplyToRecordId: bigint,
): Uint8Array {
	return resizeRefusedReceiptRecord(
		inReplyToRecordId,
		ResizeRefusalReason.HOST_EXITING,
	);
}

export function wheelReceiptRecord(
	inReplyToRecordId: bigint,
	appliedIntentSeq: bigint,
	terminalEpoch = DEFAULT_TERMINAL_EPOCH,
): Uint8Array {
	return encodeTerminalStateRecord(
		901n,
		create(TerminalStateRecordSchema, {
			schemaMinor: 5,
			terminalEpoch,
			throughOutputSeq: 0n,
			stateRevision: 1n,
			body: {
				case: "wheelReceipt",
				value: create(WheelReceiptSchema, {
					inReplyToRecordId,
					outcome: {
						case: "appliedToViewport",
						value: create(WheelAppliedToViewportSchema, { appliedIntentSeq }),
					},
				}),
			},
		}),
	);
}

export function wheelFailureReceiptRecord(
	inReplyToRecordId: bigint,
	outcome: "refused" | "failed",
	terminalEpoch = DEFAULT_TERMINAL_EPOCH,
): Uint8Array {
	return encodeTerminalStateRecord(
		903n,
		create(TerminalStateRecordSchema, {
			schemaMinor: 5,
			terminalEpoch,
			throughOutputSeq: 0n,
			stateRevision: 1n,
			body: {
				case: "wheelReceipt",
				value: create(WheelReceiptSchema, {
					inReplyToRecordId,
					outcome:
						outcome === "refused"
							? {
									case: "refused",
									value: create(WheelRefusedSchema, {
										reason: WheelRefusalReason.HOST_EXITING,
									}),
								}
							: {
									case: "failed",
									value: create(WheelFailedSchema, {
										reason: WheelFailureReason.VIEWPORT_FAILED,
									}),
								},
				}),
			},
		}),
	);
}

export function clipboardEventRecord(
	eventId: bigint,
	text: string,
	terminalEpoch = DEFAULT_TERMINAL_EPOCH,
): Uint8Array {
	return encodeTerminalStateRecord(
		eventId + 100n,
		create(TerminalStateRecordSchema, {
			schemaMinor: 3,
			terminalEpoch,
			throughOutputSeq: 1n,
			stateRevision: 1n,
			body: {
				case: "event",
				value: create(TerminalEventSchema, {
					eventId,
					event: {
						case: "clipboardWriteRequest",
						value: create(ClipboardWriteRequestEventSchema, {
							format: ClipboardFormat.UTF8_TEXT,
							content: new TextEncoder().encode(text),
						}),
					},
				}),
			},
		}),
	);
}

export function executionMarkerRecord(
	eventId: bigint,
	label: string,
	terminalEpoch = DEFAULT_TERMINAL_EPOCH,
): Uint8Array {
	return encodeTerminalStateRecord(
		eventId + 100n,
		create(TerminalStateRecordSchema, {
			schemaMinor: 3,
			terminalEpoch,
			throughOutputSeq: 1n,
			stateRevision: 1n,
			body: {
				case: "event",
				value: create(TerminalEventSchema, {
					eventId,
					event: {
						case: "executionMarker",
						value: create(ExecutionMarkerEventSchema, {
							markerId: "osc-778-managed-started",
							kind: MarkerKind.OUTPUT,
							label,
						}),
					},
				}),
			},
		}),
	);
}

export function bellEventRecord(
	eventId: bigint,
	revision: bigint,
	terminalEpoch = DEFAULT_TERMINAL_EPOCH,
): Uint8Array {
	return encodeTerminalStateRecord(
		100_000n + eventId,
		create(TerminalStateRecordSchema, {
			schemaMinor: 3,
			terminalEpoch,
			throughOutputSeq: revision,
			stateRevision: revision,
			body: {
				case: "event",
				value: create(TerminalEventSchema, {
					eventId,
					event: { case: "bell", value: create(BellEventSchema) },
				}),
			},
		}),
	);
}

/** Encodes the carrier-close notification record (JSON control channel). */
export function closedRecord(
	code: string,
	message: string,
	retryDirective: HmuxStructuredTerminalRetryDirective,
): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({ kind: "closed", code, message, retryDirective }),
	);
}
