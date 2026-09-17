import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
	InputReceiptSchema,
	InputWrittenToPtySchema,
	InputRefusedSchema,
} from "@/contracts/terminalStateProtocol";
import { createTerminalQuickCommandInput } from "./terminalQuickCommandInput";

const command = {
	id: "one",
	label: "Status",
	text: "git status",
	appendEnter: true,
};
const receipt = (id: bigint, written = true) =>
	create(InputReceiptSchema, {
		inReplyToRecordId: id,
		outcome: written
			? { case: "writtenToPty", value: create(InputWrittenToPtySchema) }
			: { case: "refused", value: create(InputRefusedSchema) },
	});
function harness() {
	const options = {
		isCurrent: vi.fn(() => true),
		canPasteMultiline: vi.fn(() => true),
		paste: vi.fn((_text: string): bigint | undefined => 1n),
		enter: vi.fn((): bigint | undefined => 2n),
	};
	return { ...options, controller: createTerminalQuickCommandInput(options) };
}
describe("Quick Command input sequence", () => {
	it("waits for the exact paste receipt before sending Enter exactly once", async () => {
		const h = harness();
		const done = h.controller.run(command);
		expect(h.paste).toHaveBeenCalledWith(command.text);
		expect(h.enter).not.toHaveBeenCalled();
		h.controller.onReceipt(receipt(99n));
		expect(h.enter).not.toHaveBeenCalled();
		h.controller.onReceipt(receipt(1n));
		h.controller.onReceipt(receipt(1n));
		expect(h.enter).toHaveBeenCalledOnce();
		h.controller.onReceipt(receipt(2n));
		await done;
	});
	it("preserves multiline text and sends no Enter in input-only mode", async () => {
		const h = harness();
		const text = "/goal Review\n  src/a.ts\n";
		const done = h.controller.run({ ...command, text, appendEnter: false });
		h.controller.onReceipt(receipt(1n));
		await done;
		expect(h.paste).toHaveBeenCalledWith(text);
		expect(h.enter).not.toHaveBeenCalled();
	});
	it.each(["refused", "replaced", "disposed"])(
		"never submits an old draft after paste is %s",
		async (cause) => {
			const h = harness();
			const done = expect(h.controller.run(command)).rejects.toThrow(
				"unavailable",
			);
			if (cause === "replaced") h.isCurrent.mockReturnValue(false);
			if (cause === "disposed") h.controller.dispose();
			else h.controller.onReceipt(receipt(1n, cause !== "refused"));
			await done;
			expect(h.enter).not.toHaveBeenCalled();
		},
	);
	it("refuses unsafe multiline paste before writing any bytes", async () => {
		const h = harness();
		h.canPasteMultiline.mockReturnValue(false);
		await expect(
			h.controller.run({
				...command,
				text: "first\nsecond",
				appendEnter: false,
			}),
		).rejects.toThrow("multilineUnavailable");
		expect(h.paste).not.toHaveBeenCalled();
	});
	it("refuses overlapping requests and surfaces a failed Enter without replaying text", async () => {
		const h = harness();
		h.enter.mockReturnValue(undefined);
		const done = expect(h.controller.run(command)).rejects.toThrow(
			"enterFailed",
		);
		await expect(h.controller.run(command)).rejects.toThrow("busy");
		h.controller.onReceipt(receipt(1n));
		await done;
		expect(h.paste).toHaveBeenCalledOnce();
	});
});
