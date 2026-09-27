import { create } from "@bufbuild/protobuf";
import {
	configureTextEncoding,
	getTextEncoding,
} from "@bufbuild/protobuf/wire";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalStateRecordSchema } from "../../../contracts/terminalStateProtocol";
import {
	decodeTerminalStateRecord,
	encodeTerminalStateRecord,
} from "./terminalStateProtocol";
import { TerminalViewportFrameDecoder } from "./terminalViewportFrameDecoder";

const encoding = getTextEncoding();
afterEach(() => {
	configureTextEncoding(encoding);
	vi.unstubAllGlobals();
});

const record = create(TerminalStateRecordSchema, {
	schemaMinor: 4,
	terminalEpoch: "epoch-한🙂",
	throughOutputSeq: 1n,
	stateRevision: 1n,
	body: {
		case: "event",
		value: { eventId: 1n, event: { case: "bell", value: {} } },
	},
});
const valid = encodeTerminalStateRecord(1n, record);

function brokenEncoding() {
	const decodeUtf8 = vi.fn(() => {
		throw new TypeError("private decoder detail");
	});
	const broken = { ...encoding, decodeUtf8 };
	configureTextEncoding(broken);
	return broken;
}

it("repairs a persistently failed shared decoder without recreating attachments", () => {
	const broken = brokenEncoding();
	// New viewport caches still share protobuf's text codec: a reconnect alone
	// does not replace it. Each read must recover inside the same JS realm.
	for (let index = 0; index < 28; index += 1) {
		expect(
			decodeTerminalStateRecord(valid, new TerminalViewportFrameDecoder())
				.record,
		).toEqual(record);
	}
	expect(broken.decodeUtf8).toHaveBeenCalledTimes(2); // failed read, fixed canary
	expect(getTextEncoding()).not.toBe(broken);
	expect(getTextEncoding().encodeUtf8).toBe(encoding.encodeUtf8);
	expect(getTextEncoding().checkUtf8).toBe(encoding.checkUtf8);
});

it("does not replace a working codec when the record contains invalid UTF-8", () => {
	const invalid = valid.slice();
	invalid[invalid.indexOf(0xed, 20)] = 0xff;
	expect(() => decodeTerminalStateRecord(invalid)).toThrow(
		/could not be decoded/,
	);
	expect(getTextEncoding()).toBe(encoding);
	expect(decodeTerminalStateRecord(valid).record).toEqual(record);
});

it("still rejects malformed UTF-8 after repairing the codec", () => {
	const invalid = valid.slice();
	invalid[invalid.indexOf(0xed, 20)] = 0xff;
	const broken = brokenEncoding();
	expect(() => decodeTerminalStateRecord(invalid)).toThrow(
		/could not be decoded/,
	);
	expect(getTextEncoding()).not.toBe(broken);
	expect(decodeTerminalStateRecord(valid).record).toEqual(record);
});

it("keeps envelope validation after repairing the codec", () => {
	brokenEncoding();
	const wrongKind = valid.slice();
	wrongKind[6] = 8;
	expect(() => decodeTerminalStateRecord(wrongKind)).toThrow(
		/kind does not match/,
	);
	expect(decodeTerminalStateRecord(valid).record).toEqual(record);
});

it("does not loop or install a replacement when fresh platform decoding also fails", () => {
	const broken = brokenEncoding();
	const replacement = vi.fn(
		class {
			constructor() {
				throw new RangeError("unavailable");
			}
		},
	);
	vi.stubGlobal("TextDecoder", replacement);
	expect(() => decodeTerminalStateRecord(valid)).toThrow(/cause=TypeError/);
	expect(replacement).toHaveBeenCalledTimes(1);
	expect(broken.decodeUtf8).toHaveBeenCalledTimes(2);
	expect(getTextEncoding()).toBe(broken);
});
