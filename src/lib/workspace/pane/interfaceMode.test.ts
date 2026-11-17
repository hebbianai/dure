import { describe, expect, it } from "vitest";
import {
	agentSpawnInteractionPreference,
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

describe("agent spawn interaction preference", () => {
	it("leaves new agents unpinned by default so a supported launch starts in Chat", () => {
		expect(agentSpawnInteractionPreference()).toBeUndefined();
		expect(agentSpawnInteractionPreference({})).toBeUndefined();
	});

	it.each(["basic", "pro", undefined])("applies the saved choice in the %s interface", (interfaceMode) => {
		const chat = { interfaceMode, defaultAgentPane: "chat" };
		const terminal = { interfaceMode, defaultAgentPane: "terminal" };
		expect(agentSpawnInteractionPreference(chat)).toBeUndefined();
		expect(agentSpawnInteractionPreference(terminal)).toBe("native_cli");
	});

	it("treats an unknown stored value as the Chat default", () => {
		for (const defaultAgentPane of [undefined, null, "unknown", true]) {
			expect(agentSpawnInteractionPreference({ defaultAgentPane })).toBeUndefined();
		}
	});
});
