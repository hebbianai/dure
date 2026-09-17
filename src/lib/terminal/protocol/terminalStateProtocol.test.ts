import { readFileSync } from "node:fs";
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	AgentPromptInputIntentSchema,
	BellEventSchema,
	BufferId,
	CellStyleSchema,
	CursorShape,
	CursorStateSchema,
	ExistingConversationPromptTargetSchema,
	FreshAgentPromptTargetSchema,
	GraphemeSchema,
	InputIntentSchema,
	InputModesSchema,
	InputOutputTimingSchema,
	InputReceiptSchema,
	InputWrittenToPtySchema,
	MouseEncoding,
	MouseTrackingMode,
	PasteInputIntentSchema,
	ResizeInputIntentSchema,
	RowTermination,
	ScrollRowsSchema,
	TerminalColorOverridesSchema,
	TerminalEventSchema,
	TerminalRowSchema,
	TerminalStateRecordSchema,
	TerminalTablesSchema,
	TextInputIntentSchema,
	UnderlineKind,
	UnicodeWidthProfileSchema,
	ViewportAnchorStatus,
	ViewportFrameSchema,
	ViewportIntentSchema,
	WheelAppliedToViewportSchema,
	WheelReceiptSchema,
} from "../../../contracts/terminalStateProtocol";
import {
	decodeTerminalStateRecord,
	encodeTerminalInputAtWriter,
	encodeTerminalStateRecord,
	TerminalStateProtocolError,
	validateTerminalInputIngress,
} from "./terminalStateProtocol";

const LEGACY_CURRENT_SNAPSHOT = fixture("terminal-state-current-v1.bin");
const LEGACY_PREVIOUS_SNAPSHOT = new Uint8Array(
	readFileSync(
		new URL(
			"../../../../hmux/crates/terminal-state-protocol/compat/previous/terminal-state-v1.bin",
			import.meta.url,
		),
	),
);

function bellRecord() {
	return create(TerminalStateRecordSchema, {
		schemaMinor: 4,
		terminalEpoch: "typed-records",
		throughOutputSeq: 17n,
		stateRevision: 9n,
		body: {
			case: "event",
			value: create(TerminalEventSchema, {
				eventId: 1n,
				event: { case: "bell", value: create(BellEventSchema) },
			}),
		},
	});
}

describe("TerminalSurface binary protocol", () => {
	it("rejects archived snapshot records instead of downgrading", () => {
		for (const encoded of [LEGACY_CURRENT_SNAPSHOT, LEGACY_PREVIOUS_SNAPSHOT]) {
			expectProtocolError(
				() => decodeTerminalStateRecord(encoded),
				"invalid_record",
			);
		}
	});

	it("uses a direct binary envelope and tolerates additive unknown fields", () => {
		const encoded = encodeTerminalStateRecord(1n, bellRecord());
		expect(new TextDecoder().decode(encoded.subarray(0, 4))).toBe("TSPB");
		expect(encoded.includes("{".charCodeAt(0))).toBe(false);

		const extended = new Uint8Array(encoded.byteLength + 3);
		extended.set(encoded);
		extended.set([0x98, 0x06, 0x07], encoded.byteLength); // field 99, varint 7
		new DataView(extended.buffer).setUint32(
			8,
			encoded.byteLength - 20 + 3,
			true,
		);

		expect(decodeTerminalStateRecord(extended).record.stateRevision).toBe(9n);
	});

	it("rejects semantic cap violations before encoding", () => {
		const oversized = create(TerminalStateRecordSchema, {
			...bellRecord(),
			terminalEpoch: "x".repeat(129),
		});

		try {
			encodeTerminalStateRecord(1n, oversized);
			expect.fail("oversized terminal epoch was accepted");
		} catch (error) {
			expect(error).toBeInstanceOf(TerminalStateProtocolError);
			expect((error as TerminalStateProtocolError).code).toBe("invalid_record");
		}
	});

	it("rejects a peer-declared oversized payload before protobuf decode", () => {
		const header = encodeTerminalStateRecord(1n, bellRecord()).slice(0, 20);
		new DataView(header.buffer).setUint32(8, 1024 * 1024 + 1, true);

		expectProtocolError(
			() => decodeTerminalStateRecord(header),
			"frame_too_large",
		);
	});

	it("round-trips typed terminal events and input intents as distinct records", () => {
		const base = {
			schemaMinor: 2,
			terminalEpoch: "typed-records",
			throughOutputSeq: 17n,
			stateRevision: 9n,
		};
		const event = create(TerminalStateRecordSchema, {
			...base,
			body: {
				case: "event",
				value: create(TerminalEventSchema, {
					eventId: 1n,
					event: { case: "bell", value: create(BellEventSchema) },
				}),
			},
		});
		const input = create(TerminalStateRecordSchema, {
			...base,
			body: {
				case: "inputIntent",
				value: create(InputIntentSchema, {
					intent: {
						case: "text",
						value: create(TextInputIntentSchema, {
							utf8: new TextEncoder().encode("계"),
						}),
					},
				}),
			},
		});

		expect(
			decodeTerminalStateRecord(encodeTerminalStateRecord(1n, event)).metadata
				.kind,
		).toBe("event");
		expect(
			decodeTerminalStateRecord(encodeTerminalStateRecord(2n, input)).metadata
				.kind,
		).toBe("input_intent");
	});

	it("round-trips complete viewport frames and ordered viewport intents", () => {
		const fence = {
			schemaMinor: 3,
			terminalEpoch: "viewport-terminal",
			throughOutputSeq: 7n,
			stateRevision: 5n,
		};
		const frame = create(TerminalStateRecordSchema, {
			...fence,
			body: {
				case: "viewportFrame",
				value: create(ViewportFrameSchema, {
					projectionRevision: 1n,
					canonicalColumns: 80,
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
						styles: [
							create(CellStyleSchema, { underline: UnderlineKind.NONE }),
						],
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
					appliedIntentSeq: 1n,
					anchorStatus: ViewportAnchorStatus.FOLLOW_TAIL,
					rowsFromTail: 0n,
					inputOutputTiming: create(InputOutputTimingSchema, {
						inputBaselineOutputSequence: 6n,
						firstOutputSequence: 7n,
						inputToOutputMicros: 4_200n,
						outputToProjectionStartMicros: 1_500n,
						inputRecordId: 8n,
					}),
				}),
			},
		});
		const intent = create(TerminalStateRecordSchema, {
			...fence,
			body: {
				case: "viewportIntent",
				value: create(ViewportIntentSchema, {
					observedProjectionRevision: 1n,
					intentSeq: 2n,
					intent: {
						case: "scrollRows",
						value: create(ScrollRowsSchema, { rows: 3 }),
					},
				}),
			},
		});

		const decodedFrame = decodeTerminalStateRecord(
			encodeTerminalStateRecord(8n, frame),
		);
		expect(decodedFrame.metadata.kind).toBe("viewport_frame");
		expect(
			decodedFrame.record.body.case === "viewportFrame"
				? decodedFrame.record.body.value.inputOutputTiming
				: undefined,
		).toMatchObject({
			inputBaselineOutputSequence: 6n,
			firstOutputSequence: 7n,
			inputToOutputMicros: 4_200n,
			outputToProjectionStartMicros: 1_500n,
			inputRecordId: 8n,
		});
		if (
			frame.body.case !== "viewportFrame" ||
			!frame.body.value.inputOutputTiming
		) {
			throw new Error("viewport timing fixture is missing");
		}
		frame.body.value.inputOutputTiming.firstOutputSequence = 8n;
		expect(() => encodeTerminalStateRecord(8n, frame)).toThrowError(
			/viewport input\/output timing exceeds its output high-water/,
		);
		frame.body.value.inputOutputTiming.firstOutputSequence = 7n;
		frame.body.value.inputOutputTiming.inputRecordId = 0n;
		expect(() => encodeTerminalStateRecord(8n, frame)).toThrowError(
			/viewport input\/output timing record ID is missing/,
		);
		expect(
			decodeTerminalStateRecord(encodeTerminalStateRecord(9n, intent)).metadata
				.kind,
		).toBe("viewport_intent");
	});

	it("accepts an InputIntent without a controller lease receipt", () => {
		const input = create(TerminalStateRecordSchema, {
			schemaMinor: 2,
			terminalEpoch: "typed-records",
			throughOutputSeq: 17n,
			stateRevision: 9n,
			body: {
				case: "inputIntent",
				value: create(InputIntentSchema, {
					intent: {
						case: "text",
						value: create(TextInputIntentSchema, {
							utf8: new TextEncoder().encode("계"),
						}),
					},
				}),
			},
		});

		expect(() => encodeTerminalStateRecord(2n, input)).not.toThrow();
	});

	it("preserves exact input write baselines within the receipt high-water", () => {
		const receipt = create(TerminalStateRecordSchema, {
			schemaMinor: 4,
			terminalEpoch: "input-baseline",
			throughOutputSeq: 0n,
			stateRevision: 1n,
			body: {
				case: "inputReceipt",
				value: create(InputReceiptSchema, {
					inReplyToRecordId: 17n,
					outcome: {
						case: "writtenToPty",
						value: create(InputWrittenToPtySchema, {
							inputBaselineOutputSequence: 0n,
						}),
					},
				}),
			},
		});
		const decoded = decodeTerminalStateRecord(
			encodeTerminalStateRecord(17n, receipt),
		).record;
		expect(
			decoded.body.case === "inputReceipt" &&
				decoded.body.value.outcome.case === "writtenToPty"
				? decoded.body.value.outcome.value.inputBaselineOutputSequence
				: undefined,
		).toBe(0n);

		if (
			receipt.body.case !== "inputReceipt" ||
			receipt.body.value.outcome.case !== "writtenToPty"
		) {
			throw new Error("input receipt fixture is missing");
		}
		receipt.body.value.outcome.value.inputBaselineOutputSequence = undefined;
		expect(() => encodeTerminalStateRecord(17n, receipt)).not.toThrow();
		receipt.body.value.outcome.value.inputBaselineOutputSequence = 1n;
		expect(() => encodeTerminalStateRecord(17n, receipt)).toThrow(
			/input receipt write baseline exceeds its output high-water/,
		);
		receipt.body.value.outcome.value.inputBaselineOutputSequence = -1n;
		expect(() => encodeTerminalStateRecord(17n, receipt)).toThrow(
			/input receipt write baseline is not a uint64/,
		);
	});

	it("rejects wheel receipts below the additive wheel minor", () => {
		const receipt = create(TerminalStateRecordSchema, {
			schemaMinor: 4,
			terminalEpoch: "typed-records",
			throughOutputSeq: 17n,
			stateRevision: 9n,
			body: {
				case: "wheelReceipt",
				value: create(WheelReceiptSchema, {
					inReplyToRecordId: 8n,
					outcome: {
						case: "appliedToViewport",
						value: create(WheelAppliedToViewportSchema, {
							appliedIntentSeq: 3n,
						}),
					},
				}),
			},
		});

		expect(() => encodeTerminalStateRecord(2n, receipt)).toThrow(
			/wheel protocol minor/,
		);
	});

	it("uses the Host wheel receipt record kind", () => {
		const receipt = create(TerminalStateRecordSchema, {
			schemaMinor: 5,
			terminalEpoch: "typed-records",
			throughOutputSeq: 17n,
			stateRevision: 9n,
			body: {
				case: "wheelReceipt",
				value: create(WheelReceiptSchema, {
					inReplyToRecordId: 8n,
					outcome: {
						case: "appliedToViewport",
						value: create(WheelAppliedToViewportSchema, {
							appliedIntentSeq: 3n,
						}),
					},
				}),
			},
		});

		const encoded = encodeTerminalStateRecord(8n, receipt);
		expect(encoded[6]).toBe(13);
		expect(decodeTerminalStateRecord(encoded).metadata.kind).toBe(
			"wheel_receipt",
		);
	});

	it("fences Host ingress to the terminal epoch and resize geometry only", () => {
		const input = create(TerminalStateRecordSchema, {
			schemaMinor: 2,
			terminalEpoch: "current-epoch",
			stateRevision: 9n,
			body: {
				case: "inputIntent",
				value: create(InputIntentSchema, {
					intent: {
						case: "text",
						value: create(TextInputIntentSchema, {
							utf8: new TextEncoder().encode("x"),
						}),
					},
				}),
			},
		});

		const authority = {
			terminalEpoch: "current-epoch",
			geometryGeneration: 1n,
		};
		expect(() => validateTerminalInputIngress(input, authority)).not.toThrow();
		expect(() =>
			encodeTerminalInputAtWriter(2, 1n, input, authority),
		).not.toThrow();
		expect(() =>
			validateTerminalInputIngress(input, {
				...authority,
				terminalEpoch: "stale-epoch",
			}),
		).toThrow(/terminal epoch/);

		const staleResize = create(TerminalStateRecordSchema, {
			...input,
			body: {
				case: "inputIntent",
				value: create(InputIntentSchema, {
					intent: {
						case: "resize",
						value: create(ResizeInputIntentSchema, {
							columns: 80,
							rows: 24,
							geometryGeneration: 0n,
						}),
					},
				}),
			},
		});
		expect(() =>
			encodeTerminalInputAtWriter(2, 2n, staleResize, authority),
		).toThrow(/geometry generation/);
	});

	it("validates targeted agent prompts and their correlated runtime revision", () => {
		const prompt = create(TerminalStateRecordSchema, {
			schemaMinor: 4,
			terminalEpoch: "current-epoch",
			stateRevision: 1n,
			body: {
				case: "inputIntent",
				value: create(InputIntentSchema, {
					intent: {
						case: "agentPrompt",
						value: create(AgentPromptInputIntentSchema, {
							utf8: new TextEncoder().encode("ship it"),
							target: {
								case: "freshAgent",
								value: create(FreshAgentPromptTargetSchema),
							},
						}),
					},
				}),
			},
		});
		const authority = {
			terminalEpoch: "current-epoch",
			geometryGeneration: 1n,
		};
		expect(() => validateTerminalInputIngress(prompt, authority)).not.toThrow();

		const existing =
			prompt.body.case === "inputIntent"
				? create(TerminalStateRecordSchema, {
						...prompt,
						body: {
							case: "inputIntent",
							value: create(InputIntentSchema, {
								intent: {
									case: "agentPrompt",
									value: create(AgentPromptInputIntentSchema, {
										utf8: new TextEncoder().encode("continue"),
										admissionWaitMs: 1,
										target: {
											case: "existingConversation",
											value: create(ExistingConversationPromptTargetSchema, {
												expectedProviderId: "codex",
												expectedConversationId: "conversation-1",
											}),
										},
									}),
								},
							}),
						},
					})
				: prompt;
		expect(() => validateTerminalInputIngress(existing, authority)).toThrow(
			/existing conversation prompt cannot wait/,
		);

		const receipt = create(TerminalStateRecordSchema, {
			schemaMinor: 4,
			terminalEpoch: "current-epoch",
			throughOutputSeq: 7n,
			stateRevision: 1n,
			body: {
				case: "inputReceipt",
				value: create(InputReceiptSchema, {
					inReplyToRecordId: 9n,
					outcome: {
						case: "writtenToPty",
						value: create(InputWrittenToPtySchema, {
							inputBaselineOutputSequence: 7n,
							agentRuntimeRevision: 3n,
						}),
					},
				}),
			},
		});
		expect(() => encodeTerminalStateRecord(9n, receipt)).not.toThrow();
	});

	it("does not let clients select bracketed-paste encoding", () => {
		const utf8 = new TextEncoder().encode("paste");
		const plain = create(PasteInputIntentSchema, { utf8 });
		const clientSelected = create(PasteInputIntentSchema, {
			utf8,
			...({ bracketed: true } as Record<string, unknown>),
		});

		expect(toBinary(PasteInputIntentSchema, clientSelected)).toEqual(
			toBinary(PasteInputIntentSchema, plain),
		);
	});
});

function fixture(name: string): Uint8Array {
	return new Uint8Array(
		readFileSync(
			new URL(
				`../../../../hmux/crates/terminal-state-protocol/fixtures/${name}`,
				import.meta.url,
			),
		),
	);
}

function expectProtocolError(
	action: () => unknown,
	code: TerminalStateProtocolError["code"],
): void {
	try {
		action();
		expect.fail(`terminal state protocol error ${code} was not raised`);
	} catch (error) {
		expect(error).toBeInstanceOf(TerminalStateProtocolError);
		expect((error as TerminalStateProtocolError).code).toBe(code);
	}
}
