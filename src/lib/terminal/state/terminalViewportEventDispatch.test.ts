import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
	ClipboardFormat,
	ClipboardWriteRequestEventSchema,
	TerminalEventSchema,
} from "@/contracts/terminalStateProtocol";
import { dispatchTerminalViewportEvent } from "./terminalViewportEventDispatch";

describe("terminal viewport event dispatch", () => {
	it("decodes the validated UTF-8 clipboard effect once at the UI boundary", () => {
		const writeClipboard = vi.fn();
		dispatchTerminalViewportEvent(
			create(TerminalEventSchema, {
				eventId: 8n,
				event: {
					case: "clipboardWriteRequest",
					value: create(ClipboardWriteRequestEventSchema, {
						format: ClipboardFormat.UTF8_TEXT,
						content: new TextEncoder().encode("한글 clipboard"),
					}),
				},
			}),
			{
				bell: vi.fn(),
				writeClipboard,
				notify: vi.fn(),
				executionMarker: vi.fn(),
			},
		);

		expect(writeClipboard).toHaveBeenCalledOnce();
		expect(writeClipboard).toHaveBeenCalledWith("한글 clipboard");
	});

	it("rejects malformed UTF-8 instead of replacing it", () => {
		const event = create(TerminalEventSchema, {
			eventId: 1n,
			event: {
				case: "clipboardWriteRequest",
				value: create(ClipboardWriteRequestEventSchema, {
					format: ClipboardFormat.UTF8_TEXT,
					content: new Uint8Array([0xff]),
				}),
			},
		});
		expect(() =>
			dispatchTerminalViewportEvent(event, {
				bell: vi.fn(),
				writeClipboard: vi.fn(),
				notify: vi.fn(),
				executionMarker: vi.fn(),
			}),
		).toThrow();
	});
});
