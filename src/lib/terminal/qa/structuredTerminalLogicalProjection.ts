import { RowTermination } from "@/contracts/terminalStateProtocol";

interface StructuredTerminalLogicalRow {
	readonly logicalLineId: bigint;
	readonly logicalCellOffset: number;
	readonly logicalCellSpan: number;
	readonly continuesFromPrevious: boolean;
	readonly termination: RowTermination;
}

/** Joins only engine-proven adjacent soft-wrap rows into logical text. */
export function structuredTerminalLogicalProjectionText(
	rows: readonly StructuredTerminalLogicalRow[],
	physicalText: readonly string[],
): string {
	let text = "";
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		const previous = rows[index - 1];
		if (previous) {
			const continuousSoftWrap =
				previous.termination === RowTermination.SOFT_WRAP &&
				previous.logicalLineId === row.logicalLineId &&
				row.continuesFromPrevious &&
				previous.logicalCellOffset + previous.logicalCellSpan ===
					row.logicalCellOffset;
			if (!continuousSoftWrap) text += "\n";
		}
		text += physicalText[index] ?? "";
	}
	return text;
}

const STRUCTURED_TERMINAL_QA_MARKER =
	/HMUX_(?:WINDOW_QA_[A-F0-9]{12}_[ABS]_\d{4}|SCROLL_QA_[A-F0-9]{12}_READY)/g;

/** Counts markers in logical lines so engine-proven soft wraps stay transparent. */
export function structuredTerminalQaMarkerCounts(
	rows: readonly StructuredTerminalLogicalRow[],
	physicalText: readonly string[],
): Record<string, number> {
	const counts: Record<string, number> = {};
	const logicalText = structuredTerminalLogicalProjectionText(
		rows,
		physicalText,
	);
	for (const match of logicalText.matchAll(STRUCTURED_TERMINAL_QA_MARKER)) {
		counts[match[0]] = (counts[match[0]] ?? 0) + 1;
	}
	return counts;
}
