import { create, toBinary } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import {
	TerminalRowSchema,
	ViewportFrameSchema,
} from "../../../contracts/terminalStateProtocol";
import { TerminalViewportFrameDecoder } from "./terminalViewportFrameDecoder";

// This boundary decodes protobuf and stages row reuse. The protocol caller
// validates full-frame semantics before authorizing commit.
function encodedRows(graphemeIndex: number): Uint8Array {
	return toBinary(
		ViewportFrameSchema,
		create(ViewportFrameSchema, {
			rows: [
				create(TerminalRowSchema, {
					rowId: 1n,
					cells: [{ graphemeIndex }],
				}),
			],
		}),
	);
}

it("reuses only committed rows and preserves them across rejected or invalid frames", () => {
	const decoder = new TerminalViewportFrameDecoder();
	const original = encodedRows(0);
	const changed = encodedRows(1);
	const uncommitted = decoder.decode(original);
	const accepted = decoder.decode(original);
	expect(accepted.rows[0]).not.toBe(uncommitted.rows[0]);
	decoder.commit();

	const rejected = decoder.decode(changed);
	expect(rejected.rows[0]).not.toBe(accepted.rows[0]);
	decoder.discard();
	expect(decoder.decode(original).rows[0]).toBe(accepted.rows[0]);
	decoder.commit();

	decoder.decode(changed);
	expect(() => decoder.decode(Uint8Array.of(0x32, 0xff))).toThrow();
	decoder.commit();
	expect(decoder.decode(original).rows[0]).toBe(accepted.rows[0]);

	const replacement = decoder.decode(changed);
	decoder.commit();
	expect(decoder.decode(changed).rows[0]).toBe(replacement.rows[0]);
	expect(replacement.rows[0]?.cells[0]?.graphemeIndex).toBe(1);
});
