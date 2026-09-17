import { describe, expect, it } from "vitest";
import { parseManagedCreateAdvanceResolution } from "./managedCreateResolution";

const parseReceipt = (value: unknown): { id: string } | undefined =>
	typeof value === "object" &&
	value !== null &&
	(value as { id?: unknown }).id === "receipt-1"
		? { id: "receipt-1" }
		: undefined;

describe("managed create advance resolution", () => {
	it.each([
		{ state: "current", receipt: { id: "receipt-1" } },
		{ state: "advanced", receipt: { id: "receipt-1" } },
		{
			state: "retry_same",
			reason: "authority_unavailable",
			code: "authority_unavailable",
			message: "retry the exact identity",
		},
		{ state: "rejected", code: "request_invalid", message: "invalid" },
	])("parses the closed advance state $state", (resolution) => {
		expect(
			parseManagedCreateAdvanceResolution(resolution, parseReceipt),
		).toEqual(resolution);
	});

	it.each([
		{ state: "advanced", receipt: { id: "wrong" } },
		{ state: "normalize_existing", existing: { id: "receipt-1" } },
		{ state: "identity_terminal", reason: "retired" },
		{
			state: "retry_same",
			reason: "reconcile_failed",
			code: "legacy_only",
			message: "legacy create state must not cross the advance boundary",
		},
	])("refuses a non-advance state $state", (resolution) => {
		expect(
			parseManagedCreateAdvanceResolution(resolution, parseReceipt),
		).toBeUndefined();
	});
});
