import { describe, expect, it } from "vitest";
import {
	providerLaunchPermissionOverrides,
	providerPermissionOptions,
} from "./providerPermissions";

describe("adapter-owned permission choices", () => {
	it.each(["claude", "codex", "gemini"])(
		"offers exact auto-edit for %s",
		(provider) => {
			expect(providerLaunchPermissionOverrides(provider)).toEqual([
				"require_approvals",
				"auto_edit",
				"bypass_approvals",
			]);
		},
	);
	it("offers plan mode only where the adapter can launch it, never as a launch override", () => {
		expect(
			providerPermissionOptions("claude").map((option) => option.value),
		).toEqual(["default", "auto_edit", "plan", "skip_permissions"]);
		expect(
			providerPermissionOptions("claude").find((option) => option.value === "plan")
				?.override,
		).toBeUndefined();
		for (const provider of ["codex", "gemini", "opencode"]) {
			expect(
				providerPermissionOptions(provider).map((option) => option.value),
			).not.toContain("plan");
		}
	});
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
