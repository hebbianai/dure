import { describe, expect, it } from "vitest";
import {
	acknowledgeTerminalIntentReceipt,
	cancelTerminalIntentReceipt,
	createTerminalIntentReceiptSequence,
	issueTerminalIntentReceipt,
	issueTerminalUserInputReceipt,
	terminalIntentReceiptPendingKinds,
} from "./terminalIntentReceiptSequence";

describe("terminal intent receipt sequence", () => {
	it("retains only high-water marks and the latest fallible resize token", () => {
		const sequence = createTerminalIntentReceiptSequence<string>();
		for (let index = 1n; index <= 10_000n; index += 1n) {
			issueTerminalIntentReceipt(sequence, "input", index * 3n - 2n);
			issueTerminalIntentReceipt(
				sequence,
				"resize",
				index * 3n - 1n,
				`r${index}`,
			);
			issueTerminalIntentReceipt(sequence, "wheel", index * 3n);
		}

		expect(sequence).toMatchObject({
			input: { highestIssuedRecordId: 29_998n },
			resize: { highestIssuedRecordId: 29_999n },
			wheel: { highestIssuedRecordId: 30_000n },
			latestResize: { recordId: 29_999n, token: "r10000" },
		});
		expect(acknowledgeTerminalIntentReceipt(sequence, "resize", 2n)).toEqual({
			status: "acknowledged",
		});
		expect(sequence.latestResize).toEqual({
			recordId: 29_999n,
			token: "r10000",
		});
		expect(
			acknowledgeTerminalIntentReceipt(sequence, "resize", 29_999n),
		).toEqual({ status: "acknowledged", resizeToken: "r10000" });
		expect(sequence.latestResize).toBeUndefined();
	});

	it("bounds duplicates, unissued receipts, and cancellation without a ledger", () => {
		const sequence = createTerminalIntentReceiptSequence<string>();
		issueTerminalIntentReceipt(sequence, "resize", 4n, "current");
		expect(acknowledgeTerminalIntentReceipt(sequence, "resize", 5n)).toEqual({
			status: "unissued",
		});
		expect(acknowledgeTerminalIntentReceipt(sequence, "resize", 4n)).toEqual({
			status: "acknowledged",
			resizeToken: "current",
		});
		expect(acknowledgeTerminalIntentReceipt(sequence, "resize", 4n)).toEqual({
			status: "duplicate",
		});

		issueTerminalIntentReceipt(sequence, "resize", 8n, "replacement");
		cancelTerminalIntentReceipt(sequence, "resize", 8n);
		expect(sequence.latestResize).toBeUndefined();
		expect(acknowledgeTerminalIntentReceipt(sequence, "resize", 8n)).toEqual({
			status: "acknowledged",
		});
	});

	it("projects unresolved operation kinds from constant high-water state", () => {
		const sequence = createTerminalIntentReceiptSequence<string>();
		issueTerminalIntentReceipt(sequence, "input", 1n);
		issueTerminalIntentReceipt(sequence, "resize", 2n, "resize");
		issueTerminalIntentReceipt(sequence, "wheel", 3n);
		expect(terminalIntentReceiptPendingKinds(sequence)).toEqual({
			input: true,
			resize: true,
			wheel: true,
		});

		acknowledgeTerminalIntentReceipt(sequence, "input", 1n);
		cancelTerminalIntentReceipt(sequence, "wheel", 3n);
		expect(terminalIntentReceiptPendingKinds(sequence)).toEqual({
			input: false,
			resize: true,
			wheel: false,
		});

		acknowledgeTerminalIntentReceipt(sequence, "resize", 2n);
		expect(terminalIntentReceiptPendingKinds(sequence)).toEqual({
			input: false,
			resize: false,
			wheel: false,
		});
	});

	it("marks only the receipt for the user's newest own input", () => {
		// Focus and pointer intents share the input lane; their receipts must
		// not read as the user's keystroke landing (#705 review).
		const sequence = createTerminalIntentReceiptSequence<string>();
		issueTerminalUserInputReceipt(sequence, 1n);
		issueTerminalIntentReceipt(sequence, "input", 2n);
		issueTerminalUserInputReceipt(sequence, 3n);
		issueTerminalIntentReceipt(sequence, "input", 4n);

		expect(acknowledgeTerminalIntentReceipt(sequence, "input", 1n)).toEqual({
			status: "acknowledged",
		});
		expect(acknowledgeTerminalIntentReceipt(sequence, "input", 2n)).toEqual({
			status: "acknowledged",
		});
		expect(acknowledgeTerminalIntentReceipt(sequence, "input", 3n)).toEqual({
			status: "acknowledged",
			userInput: true,
		});
		expect(acknowledgeTerminalIntentReceipt(sequence, "input", 4n)).toEqual({
			status: "acknowledged",
		});
	});
});
