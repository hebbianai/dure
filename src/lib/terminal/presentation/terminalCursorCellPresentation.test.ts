import { describe, expect, it } from "vitest";
import { ColorKind } from "@/contracts/terminalStateProtocol";
import { decodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";
import {
	terminalCellColors,
	terminalCursorCell,
} from "./terminalCursorCellPresentation";

describe("terminal cursor-cell presentation", () => {
	it("resolves the painted row cell instead of the cursor fallback style", () => {
		const decoded = decodeTerminalStateRecord(
			viewportFrameRecord({
				cellForegroundRgb: 0xfafafa,
				cellBackgroundRgb: 0x333333,
			}),
		);
		if (decoded.record.body.case !== "viewportFrame") {
			throw new Error("expected a viewport frame");
		}

		const cell = terminalCursorCell({
			schemaMinor: decoded.record.schemaMinor,
			frame: decoded.record.body.value,
		});

		expect(cell?.style?.background).toMatchObject({
			kind: ColorKind.RGB,
			value: 0x333333,
		});
		expect(
			terminalCellColors(cell?.style, {
				foreground: "#e5e5e5",
				background: "#0a0a0a",
				indexed: () => undefined,
			}),
		).toEqual({ foreground: "#fafafa", background: "#333333" });
	});
});
