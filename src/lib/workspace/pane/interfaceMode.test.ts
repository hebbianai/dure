import { describe, expect, it } from "vitest";
import {
	agentSpawnInteractionPreference,
	resolveEffectiveInterfaceMode,
} from "@/lib/workspace/pane/interfaceMode";

describe("effective interface mode", () => {
	it.each(["pro", undefined, "future-mode"])(
		"clamps production raw %s to the Basic-only product surface",
		(storedMode) => {
			expect(resolveEffectiveInterfaceMode(storedMode, { PROD: true })).toEqual({
				mode: "basic",
				selectable: false,
			});
		},
	);

	it("keeps development selectable", () => {
		expect(resolveEffectiveInterfaceMode("basic", { PROD: false })).toEqual({
			mode: "basic",
			selectable: true,
		});
		expect(resolveEffectiveInterfaceMode("pro", { PROD: false })).toEqual({
			mode: "pro",
			selectable: true,
		});
		expect(resolveEffectiveInterfaceMode(undefined, { PROD: false })).toEqual({
			mode: "basic",
			selectable: true,
		});
		expect(resolveEffectiveInterfaceMode("unknown", { PROD: false })).toEqual({
			mode: "basic",
			selectable: true,
		});
	});

	it("honors the Basic-only override without allowing production to reopen", () => {
		expect(
			resolveEffectiveInterfaceMode("pro", {
				PROD: false,
				VITE_DURE_INTERFACE_MODE_POLICY: "basic-only",
			}),
		).toEqual({ mode: "basic", selectable: false });
		expect(
			resolveEffectiveInterfaceMode("pro", {
				PROD: true,
				VITE_DURE_INTERFACE_MODE_POLICY: "selectable",
			}),
		).toEqual({ mode: "basic", selectable: false });
	});
});

describe("agent spawn interaction preference", () => {
	/** Every mode, not just basic (owner decision 2026-09-01): the provider
	 *  default is a capability probe, and letting it choose moved the surface
	 *  under the user when a CLI version table grew an entry. */
	it("pins every new agent to the PTY surface", () => {
		expect(agentSpawnInteractionPreference()).toBe("native_cli");
	});
});
