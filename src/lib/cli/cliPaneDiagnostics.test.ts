// @vitest-environment jsdom

import { fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import { installTerminalReplacementInput } from "@/lib/terminal/interaction/terminalReplacementInput";
import { readCliPaneDiagnostics } from "./cliPaneDiagnostics";

const state = vi.hoisted(() => ({
	panes: [] as Array<{ id: string; params: Record<string, unknown>; api: { component: string; getParameters: () => unknown } }>,
	agents: [{ id: "agent-1", sessionId: "session-1" }],
	agentActivity: { "agent-1": "waiting" },
	sessionAgentRuntimeState: {
		"session-1": { activity: "working", revision: "42", terminalEpoch: "epoch-1" },
	},
}));
vi.mock("@/store", () => ({ useStore: { getState: () => state } }));
vi.mock("@/lib/workspace/dock/dockRegistry", () => ({ mountedDockviewEntries: () => [["desk-1", { getPanel: (id: string) => state.panes.find((pane) => pane.id === id) }]] }));
vi.mock("@/lib/agents/agentAttentionStore", () => ({
	useAgentAttention: { getState: () => ({ displayStates: { "agent-1": "waiting" } }) },
}));

let dispose: (() => void) | undefined;
afterEach(() => {
	state.panes.length = 0;
	dispose?.();
	document.body.replaceChildren();
	terminalInputLatency.resetMeasurements();
});

it.each(["agent:agent-1", "slot", "launcher:previous", "term:previous"])("exposes current Agent and input observations for %s without repairing either", (paneId) => {
	const pane = { id: paneId, params: { agentRef: { agentId: "agent-1" } } as Record<string, unknown>, api: { component: "agent", getParameters: () => pane.params } };
	state.panes.push(pane);
	const surface = document.createElement("div");
	const surfaceId = `window:main:desktop:desk-1:pane:${paneId}`;
	surface.dataset.terminalSurfaceId = surfaceId;
	const input = document.createElement("textarea");
	surface.append(input);
	document.body.append(surface);
	const forward = vi.fn(async () => {});
	dispose = installTerminalReplacementInput({
		input, terminalId: surfaceId, forwardUserInput: forward,
	});
	input.focus();
	fireEvent.compositionStart(input, { data: "PRIVATE_TEXT" });
	fireEvent.keyDown(input, { key: " ", code: "Space" });
	input.dispatchEvent(new InputEvent("beforeinput", {
		bubbles: true, inputType: "insertText", data: " ", isComposing: false,
	}));
	input.value = "PRIVATE_TEXT ";
	fireEvent.input(input, { inputType: "insertText", isComposing: false });
	// Deliberately no terminal consumer: the diagnostic must retain failed
	// delivery evidence independently of a successful Host dispatch.
	expect(terminalInputLatency.snapshot().samples).toEqual([]);
	const result = readCliPaneDiagnostics(paneId);
	expect(result.activity).toEqual({
		sessionId: "session-1",
		hostProjection: state.sessionAgentRuntimeState["session-1"],
		displayState: "waiting",
		presentationActivity: "waiting",
	});
	expect(result.inputs).toHaveLength(1);
	expect(result.inputs[0]).toMatchObject({ focused: true, disabled: false, readOnly: false });
	expect(result.inputs[0].browserEvents.map((event) => event.type)).toEqual([
		"focus", "compositionstart", "keydown", "beforeinput", "input",
	]);
	expect(result.inputs[0].browserEvents[2].keyKind).toBe("space");
	expect(result.inputs[0].browserEvents[4]).toMatchObject({
		inputType: "insertText", isComposing: false, focused: true, valueLength: 13,
	});
	expect(JSON.stringify(result)).not.toContain("PRIVATE_TEXT");
	expect(forward).not.toHaveBeenCalled();
	expect(document.activeElement).toBe(input);
	expect(input.value).toBe("PRIVATE_TEXT ");
	expect(readCliPaneDiagnostics("agent:agent-10").inputs).toEqual([]);
	pane.params = { agentRef: null };
	expect(readCliPaneDiagnostics(paneId).activity).toBeNull();
	pane.params = { agentRef: { agentId: "agent-1" } };
	pane.api.component = "terminal";
	expect(readCliPaneDiagnostics(paneId).activity).toBeNull();
	state.panes.length = 0;
	expect(readCliPaneDiagnostics(paneId).activity).toBeNull();
});

it("bounds event history and releases observation with the textarea attachment", () => {
	const input = document.createElement("textarea");
	document.body.append(input);
	dispose = installTerminalReplacementInput({
		input, terminalId: "bounded", forwardUserInput: vi.fn(async () => {}),
	});
	for (let index = 0; index < 200; index++) {
		fireEvent.keyDown(input, { key: "p", code: "KeyP" });
	}
	const before = terminalInputLatency.browserInputSnapshot("bounded");
	expect(before).toHaveLength(128);
	expect(before.every((event) => event.keyKind === "text")).toBe(true);
	dispose();
	dispose = undefined;
	fireEvent.keyDown(input, { key: "Backspace" });
	expect(terminalInputLatency.browserInputSnapshot("bounded")).toEqual(before);
});
