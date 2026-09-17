import { describe, expect, it } from "vitest";
import {
	HmuxInputReceiptError,
	parseHmuxCommandInputReceipt,
	parseHmuxInitialAgentPromptReceipt,
} from "./hmuxInputReceipt";

describe("Hmux input receipt parsing", () => {
	it("parses one compound command receipt at the IPC boundary", () => {
		expect(
			parseHmuxCommandInputReceipt(
				{
					terminalEpoch: "terminal-1",
					text: { state: "written_to_pty", recordId: "7" },
					submit: { state: "written_to_pty", recordId: "8" },
				},
				{ terminalEpoch: "terminal-1", text: true, submit: true },
			),
		).toEqual({
			terminalEpoch: "terminal-1",
			text: { state: "written_to_pty", recordId: "7" },
			submit: { state: "written_to_pty", recordId: "8" },
		});
	});

	it("rejects an interleaved compound command receipt", () => {
		expect(() =>
			parseHmuxCommandInputReceipt(
				{
					terminalEpoch: "terminal-1",
					text: { state: "written_to_pty", recordId: "7" },
					submit: { state: "written_to_pty", recordId: "9" },
				},
				{ terminalEpoch: "terminal-1", text: true, submit: true },
			),
		).toThrow("input_receipt_invalid");
	});

	it("returns a typed boundary error when a requested submit receipt is missing", () => {
		try {
			parseHmuxCommandInputReceipt(
				{
					terminalEpoch: "terminal-1",
					text: { state: "written_to_pty", recordId: "7" },
				},
				{ terminalEpoch: "terminal-1", text: true, submit: true },
			);
			throw new Error("expected receipt parsing to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(HmuxInputReceiptError);
			expect(error).toMatchObject({ code: "input_receipt_invalid" });
		}
	});

	it.each([
		{
			terminalEpoch: "terminal-1",
			recordId: "7",
			inputBaselineOutputSequence: "0",
			initialAgentRuntimeRevision: "3",
		},
		{
			terminalEpoch: "terminal-1",
			recordId: "8",
			inputBaselineOutputSequence: "0",
		},
	])(
		"parses a Host prompt proof with an optional runtime revision",
		(receipt) => {
			expect(parseHmuxInitialAgentPromptReceipt(receipt, "terminal-1")).toEqual(
				receipt,
			);
		},
	);

	it.each([
		{ terminalEpoch: "terminal-2" },
		{ recordId: "0" },
		{ recordId: "07" },
		{ inputBaselineOutputSequence: "-1" },
		{ initialAgentRuntimeRevision: "0" },
	])("rejects an incomplete or mismatched Host prompt proof", (patch) => {
		const receipt = {
			terminalEpoch: "terminal-1",
			recordId: "7",
			inputBaselineOutputSequence: "0",
			initialAgentRuntimeRevision: "3",
			...patch,
		};
		expect(() =>
			parseHmuxInitialAgentPromptReceipt(receipt, "terminal-1"),
		).toThrow("hmux_initial_agent_prompt_receipt_invalid");
	});
});
