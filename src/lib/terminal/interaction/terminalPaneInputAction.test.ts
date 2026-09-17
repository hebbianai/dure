import { describe, expect, it, vi } from "vitest";
import { terminalPaneInputAction } from "./terminalPaneInputAction";

describe("terminal input argument boundary", () => {
	it("preserves text and leaves Enter opt-in", async () => {
		const send = vi.fn(async () => {});
		expect(
			await terminalPaneInputAction(send)({ text: "  echo '한글'\n" }),
		).toEqual({ outcome: "applied" });
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ text: "  echo '한글'\n", appendEnter: false }),
		);
	});
	it.each([
		{ text: "echo ok\u0003" },
		{ text: "x".repeat(4097) },
		{ text: "hostname", appendEnter: "true" },
		{ text: "hostname", unknown: true },
	])("refuses invalid input without writing", async (input) => {
		const send = vi.fn(async () => {});
		expect(await terminalPaneInputAction(send)(input)).toMatchObject({
			outcome: "refused",
		});
		expect(send).not.toHaveBeenCalled();
	});
});
