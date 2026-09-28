import { expect, test } from "vitest";
import { parseAgentProgress } from "./agentProgress";

const value = {
	report: {
		source_id: "driver",
		sequence: "2",
		phase: "thinking",
		turn_id: "turn",
		message_turns: [{ delivery_receipt_id: "receipt", turn_id: "turn" }],
	},
	last_activity_unix_ms: "123",
	quiet_threshold_ms: "300000",
	progress_unconfirmed: true,
};
test("keeps exact Host evidence and omits malformed or unsupported optional progress", () => {
	expect(parseAgentProgress(value)).toEqual(value);
	for (const invalid of [
		undefined,
		null,
		{ ...value, report: { ...value.report, sequence: "0" } },
		{ ...value, quiet_threshold_ms: "0" },
		{ ...value, progress_unconfirmed: "true" },
	])
		expect(parseAgentProgress(invalid)).toBeUndefined();
});
