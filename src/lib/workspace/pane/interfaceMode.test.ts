import { describe, expect, it } from "vitest";
import {
	agentSpawnInteractionPreference,
	developmentPreviewsAvailable,
	resolveEffectiveInterfaceMode,
} from "@/lib/workspace/pane/interfaceMode";

describe("effective interface mode", () => {
	it("lets production select the Beta interface", () => {
		expect(resolveEffectiveInterfaceMode("pro", { PROD: true })).toEqual({
			mode: "pro",
			selectable: true,
		});
		expect(resolveEffectiveInterfaceMode("basic", { PROD: true })).toEqual({
			mode: "basic",
			selectable: true,
		});
	});

	it.each([undefined, "future-mode"])(
		"reads production raw %s as Basic",
		(storedMode) => {
			expect(resolveEffectiveInterfaceMode(storedMode, { PROD: true })).toEqual({
				mode: "basic",
				selectable: true,
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

	it.each([false, true])(
		"honors the Basic-only override when PROD is %s",
		(PROD) => {
			expect(
				resolveEffectiveInterfaceMode("pro", {
					PROD,
					VITE_DURE_INTERFACE_MODE_POLICY: "basic-only",
				}),
			).toEqual({ mode: "basic", selectable: false });
		},
	);
});

describe("development previews", () => {
	it("stay out of production builds", () => {
		expect(developmentPreviewsAvailable({ PROD: true })).toBe(false);
	});

	it("remain available in development", () => {
		expect(developmentPreviewsAvailable({ PROD: false })).toBe(true);
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

	it("honors the Beta Chat choice in production", () => {
		expect(agentSpawnInteractionPreference({ interfaceMode: "pro", defaultAgentPane: "chat" }, { PROD: true })).toBeUndefined();
	});

	it("keeps Basic and the Basic-only policy native without erasing the saved Chat choice", () => {
		const prefs = { interfaceMode: "pro", defaultAgentPane: "chat" };
		expect(agentSpawnInteractionPreference(prefs, { PROD: true, VITE_DURE_INTERFACE_MODE_POLICY: "basic-only" })).toBe("native_cli");
		expect(agentSpawnInteractionPreference(prefs, { PROD: false, VITE_DURE_INTERFACE_MODE_POLICY: "basic-only" })).toBe("native_cli");
		expect(agentSpawnInteractionPreference({ ...prefs, interfaceMode: "basic" }, { PROD: false })).toBe("native_cli");
		expect(prefs.defaultAgentPane).toBe("chat");
	});
});
