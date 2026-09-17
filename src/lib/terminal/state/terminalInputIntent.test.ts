import { describe, expect, it } from "vitest";
import { PointerKind } from "@/contracts/terminalStateProtocol";
import {
	encodeTerminalKeyIntent,
	encodeTerminalPasteIntent,
	encodeTerminalPointerIntent,
	encodeTerminalResizeIntent,
	encodeTerminalViewportWheelIntent,
	shouldSendTerminalKey,
} from "./terminalInputIntent";
import { decodeTerminalStateRecord } from "../protocol/terminalStateProtocol";

const fence = {
	schemaMinor: 2,
	terminalEpoch: "epoch-structured",
	throughOutputSeq: 9n,
	stateRevision: 12n,
};

describe("structured terminal input intents", () => {
	it("sends physical keys and modifiers without a controller receipt", () => {
		const encoded = encodeTerminalKeyIntent(7n, fence, {
			key: "ArrowUp",
			code: "ArrowUp",
			shiftKey: true,
			altKey: false,
			ctrlKey: true,
			metaKey: false,
			repeat: false,
			getModifierState: (name) => name === "CapsLock",
		});
		const decoded = decodeTerminalStateRecord(encoded);
		expect(decoded.metadata.recordId).toBe(7n);
		expect(decoded.record.body.case).toBe("inputIntent");
		if (decoded.record.body.case !== "inputIntent") return;
		expect(decoded.record.body.value.intent).toMatchObject({
			case: "key",
			value: { key: "ArrowUp", code: "ArrowUp", modifiers: 21 },
		});
	});

	it("encodes physical Enter as one semantic submit key", () => {
		const event = {
			key: "Enter",
			code: "Enter",
			shiftKey: false,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			repeat: false,
			isComposing: false,
			getModifierState: () => false,
		};
		expect(shouldSendTerminalKey(event)).toBe(true);
		const decoded = decodeTerminalStateRecord(
			encodeTerminalKeyIntent(8n, fence, event),
		);
		if (decoded.record.body.case !== "inputIntent") throw new Error("input");
		expect(decoded.record.body.value.intent).toMatchObject({
			case: "key",
			value: { key: "Enter", code: "Enter" },
		});
	});

	it("keeps paste semantic and leaves bracketed mode to the Host", () => {
		const decoded = decodeTerminalStateRecord(
			encodeTerminalPasteIntent(8n, fence, "first\nsecond"),
		);
		if (decoded.record.body.case !== "inputIntent") throw new Error("input");
		const intent = decoded.record.body.value.intent;
		if (intent.case !== "paste") throw new Error("paste");
		expect(new TextDecoder().decode(intent.value.utf8)).toBe("first\nsecond");
	});

	it("leaves printable text to the IME/input event and keeps terminal keys semantic", () => {
		const event = (key: string, ctrlKey = false, isComposing = false) => ({
			key,
			code: key,
			shiftKey: false,
			altKey: false,
			ctrlKey,
			metaKey: false,
			repeat: false,
			isComposing,
			getModifierState: () => false,
		});
		expect(shouldSendTerminalKey(event("a"))).toBe(false);
		expect(shouldSendTerminalKey(event("c", true))).toBe(true);
		expect(shouldSendTerminalKey(event("ArrowUp"))).toBe(true);
		expect(shouldSendTerminalKey(event("Process"))).toBe(false);
		expect(shouldSendTerminalKey(event("ArrowUp", false, true))).toBe(false);
		expect(shouldSendTerminalKey(event("Enter", false, true))).toBe(false);
	});

	it("orders resize by its connection record instead of terminal output", () => {
		const decoded = decodeTerminalStateRecord(
			encodeTerminalResizeIntent(
				17n,
				{ ...fence, stateRevision: 999n },
				120,
				40,
			),
		);
		if (decoded.record.body.case !== "inputIntent") throw new Error("input");
		const intent = decoded.record.body.value.intent;
		if (intent.case !== "resize") throw new Error("resize");
		expect(intent.value).toMatchObject({
			columns: 120,
			rows: 40,
			geometryGeneration: 17n,
		});
	});

	it("carries pixel geometry without making the surface an input owner", () => {
		const decoded = decodeTerminalStateRecord(
			encodeTerminalPointerIntent(9n, fence, {
				kind: PointerKind.DOWN,
				column: 4,
				row: 2,
				button: 0,
				buttons: 1,
				shiftKey: false,
				altKey: true,
				ctrlKey: false,
				metaKey: false,
				wheelDeltaX: 0,
				wheelDeltaY: 0,
				pixelX: 45,
				pixelY: 45,
				surfaceWidth: 800,
				surfaceHeight: 600,
				cellWidth: 10,
				cellHeight: 20,
				paddingTop: 0,
				paddingBottom: 0,
				paddingRight: 0,
				paddingLeft: 0,
			}),
		);
		if (decoded.record.body.case !== "inputIntent") throw new Error("input");
		const intent = decoded.record.body.value.intent;
		if (intent.case !== "pointer") throw new Error("pointer");
		expect(intent.value).toMatchObject({
			kind: PointerKind.DOWN,
			column: 4,
			row: 2,
			modifiers: 2,
			pixelX: 45,
			pixelY: 45,
			pressedButtons: 1,
		});
	});

	it("serializes wheel geometry through the shared pointer contract", () => {
		const decoded = decodeTerminalStateRecord(
			encodeTerminalViewportWheelIntent(
				10n,
				fence,
				{
					attachmentId: "attachment-a",
					observedProjectionRevision: 3n,
					intentSeq: 4n,
				},
				{
					kind: PointerKind.WHEEL,
					column: 4,
					row: 2,
					button: 0,
					buttons: 0,
					shiftKey: true,
					altKey: true,
					ctrlKey: false,
					metaKey: false,
					wheelDeltaX: 2,
					wheelDeltaY: -6,
					pixelX: 45,
					pixelY: 45,
					surfaceWidth: 800,
					surfaceHeight: 600,
					cellWidth: 10,
					cellHeight: 20,
					paddingTop: 0,
					paddingBottom: 0,
					paddingRight: 0,
					paddingLeft: 0,
				},
			),
		);

		expect(decoded.metadata.protocolMinor).toBe(5);
		expect(decoded.record.schemaMinor).toBe(5);
		if (decoded.record.body.case !== "viewportIntent") {
			throw new Error("viewport intent");
		}
		const intent = decoded.record.body.value;
		expect(intent).toMatchObject({
			observedProjectionRevision: 3n,
			intentSeq: 4n,
		});
		if (intent.intent.case !== "wheel") throw new Error("wheel");
		expect(intent.intent.value).toMatchObject({
			kind: PointerKind.WHEEL,
			column: 4,
			row: 2,
			modifiers: 3,
			wheelDeltaX: 2,
			wheelDeltaY: -6,
			pixelX: 45,
			pixelY: 45,
			pressedButtons: 0,
		});
	});
});
