import { describe, expect, it, vi } from "vitest";
import { definePaneAction } from "./paneAction";

describe("pane action argument boundary", () => {
	it.each([
		null,
		[],
		{ value: "unsupported" },
		{},
		{ value: "high", extra: true },
		{ value: "high", revision: 0 },
		{ value: "high", revision: 1.5 },
	])("rejects invalid arguments before execution: %j", async (input) => {
		const run = vi.fn();
		const action = definePaneAction(
			{
				description: "Setting",
				parameters: {
					value: {
						type: "string",
						required: true,
						nullable: true,
						values: [null, "high"],
					},
					revision: { type: "integer", minimum: 1 },
				},
			},
			run,
		);
		expect(await action(input)).toMatchObject({
			outcome: "refused",
			error: { code: "pane_action_arguments_invalid" },
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("passes an explicit provider default and preserves the domain receipt", async () => {
		const receipt = { outcome: "unchanged" as const, value: { revision: 4 } };
		const run = vi.fn(async () => receipt);
		const action = definePaneAction(
			{
				description: "Setting",
				parameters: {
					value: { type: "string", nullable: true, required: true },
				},
			},
			run,
		);
		expect(await action({ value: null })).toBe(receipt);
		expect(run).toHaveBeenCalledWith({ value: null });
	});

	it("returns the same unavailable reason exposed in discovery", async () => {
		const run = vi.fn();
		const reason = {
			code: "busy",
			message: "Changing runtime",
			retryable: true,
		};
		const action = definePaneAction(
			{ description: "Setting", parameters: {}, unavailable: reason },
			run,
		);
		expect(await action()).toEqual({ outcome: "refused", error: reason });
		expect(run).not.toHaveBeenCalled();
	});
});
