import { fromBinary } from "@bufbuild/protobuf";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import {
	type TerminalRow,
	TerminalRowSchema,
	type ViewportFrame,
	ViewportFrameSchema,
} from "../../../contracts/terminalStateProtocol";
import type { TerminalViewportFrameBinaryDecoder } from "./terminalStateProtocol";

interface CachedTerminalRow {
	readonly bytes: Uint8Array;
	readonly row: TerminalRow;
}

export class TerminalViewportFrameDecoder
	implements TerminalViewportFrameBinaryDecoder
{
	private installed: readonly CachedTerminalRow[] = [];
	private staged: readonly CachedTerminalRow[] | undefined;

	decode(bytes: Uint8Array): ViewportFrame {
		this.staged = undefined;
		const split = splitViewportRows(bytes);
		const frame = fromBinary(ViewportFrameSchema, split.metadata);
		const previousById = new Map(
			this.installed.map((cached) => [cached.row.rowId, cached]),
		);
		const staged = split.rows.map((rowBytes, index) => {
			const indexed = this.installed[index];
			if (indexed && equalBytes(indexed.bytes, rowBytes)) return indexed;
			const rowId = readTerminalRowId(rowBytes);
			const anchored =
				rowId === undefined ? undefined : previousById.get(rowId);
			if (anchored && equalBytes(anchored.bytes, rowBytes)) return anchored;
			return {
				bytes: rowBytes.slice(),
				row: fromBinary(TerminalRowSchema, rowBytes),
			};
		});
		frame.rows = staged.map((cached) => cached.row);
		this.staged = staged;
		return frame;
	}

	commit(): void {
		if (this.staged !== undefined) this.installed = this.staged;
		this.staged = undefined;
	}

	discard(): void {
		this.staged = undefined;
	}
}

function splitViewportRows(bytes: Uint8Array): {
	readonly metadata: Uint8Array;
	readonly rows: readonly Uint8Array[];
} {
	const reader = new BinaryReader(bytes);
	const retained: Uint8Array[] = [];
	const rows: Uint8Array[] = [];
	let retainedBytes = 0;
	while (reader.pos < reader.len) {
		const fieldStart = reader.pos;
		const [fieldNumber, wireType] = reader.tag();
		if (fieldNumber === 6) {
			if (wireType !== WireType.LengthDelimited) {
				throw new Error("viewport row has an invalid protobuf wire type");
			}
			rows.push(reader.bytes());
			continue;
		}
		reader.skip(wireType, fieldNumber);
		const field = bytes.subarray(fieldStart, reader.pos);
		retained.push(field);
		retainedBytes += field.byteLength;
	}
	const metadata = new Uint8Array(retainedBytes);
	let offset = 0;
	for (const field of retained) {
		metadata.set(field, offset);
		offset += field.byteLength;
	}
	return { metadata, rows };
}

function readTerminalRowId(bytes: Uint8Array): bigint | undefined {
	const reader = new BinaryReader(bytes);
	while (reader.pos < reader.len) {
		const [fieldNumber, wireType] = reader.tag();
		if (fieldNumber === 1 && wireType === WireType.Varint) {
			const rowId = reader.uint64();
			return typeof rowId === "bigint" ? rowId : BigInt(rowId);
		}
		reader.skip(wireType, fieldNumber);
	}
	return undefined;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}
