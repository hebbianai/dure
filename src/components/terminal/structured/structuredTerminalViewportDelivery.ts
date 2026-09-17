import type { StructuredTerminalCarrierRecord } from "@/lib/terminal/structuredTerminalRecordAdapter";

export function consumeInitialCarrierRecords(
	records: readonly StructuredTerminalCarrierRecord[],
	consume: (record: StructuredTerminalCarrierRecord) => boolean,
): boolean {
	for (const record of records) {
		if (!consume(record)) return false;
	}
	return true;
}
