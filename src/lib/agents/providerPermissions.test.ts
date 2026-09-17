import { describe, expect, it } from "vitest";
import { providerPermissionOptions } from "./providerPermissions";

describe("adapter-owned permission choices", () => {
	it.each(["claude", "codex", "gemini"])(
		"offers exact auto-edit for %s",
		(provider) => {
			expect(
				providerPermissionOptions(provider).map((option) => option.override),
			).toEqual(["require_approvals", "auto_edit", "bypass_approvals"]);
		},
	);
	it("does not invent an auto-edit mode for other reviewed providers", () => {
		expect(
			providerPermissionOptions("kimi").map((option) => option.override),
		).toEqual(["require_approvals", "bypass_approvals"]);
	});
	it("never advertises approval bypass when the adapter cannot execute it", () => {
		expect(
			providerPermissionOptions("pi").map((option) => option.override),
		).toEqual(["require_approvals"]);
		expect(providerPermissionOptions("unknown-provider")).toEqual([]);
		expect(providerPermissionOptions("__proto__")).toEqual([]);
	});
});
