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
	it("defaults new agents to the PTY surface", () => {
		expect(agentSpawnInteractionPreference()).toBe("native_cli");
	});

	it("uses Chat only for an explicit Pro preference", () => {
		expect(agentSpawnInteractionPreference({ interfaceMode: "pro", defaultAgentPane: "chat" }, { PROD: false })).toBeUndefined();
		for (const defaultAgentPane of [undefined, "terminal", "unknown"]) {
			expect(agentSpawnInteractionPreference({ interfaceMode: "pro", defaultAgentPane }, { PROD: false })).toBe("native_cli");
		}
	});

	it("keeps Basic and production native without erasing the saved Chat choice", () => {
		const prefs = { interfaceMode: "pro", defaultAgentPane: "chat" };
		expect(agentSpawnInteractionPreference(prefs, { PROD: true })).toBe("native_cli");
		expect(agentSpawnInteractionPreference(prefs, { PROD: false, VITE_DURE_INTERFACE_MODE_POLICY: "basic-only" })).toBe("native_cli");
		expect(agentSpawnInteractionPreference({ ...prefs, interfaceMode: "basic" }, { PROD: false })).toBe("native_cli");
		expect(prefs.defaultAgentPane).toBe("chat");
	});
});
