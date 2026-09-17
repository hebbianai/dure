// @vitest-environment jsdom

import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installTerminalReplacementInput } from "./terminalReplacementInput";

describe("installTerminalReplacementInput", () => {
	it("forwards a Japanese code-point replacement without clearing the textarea", () => {
		const host = document.createElement("div");
		const helper = document.createElement("textarea");
		host.append(helper);
		const forwardUserInput = vi.fn(async () => {});
		const dispose = installTerminalReplacementInput({
			input: helper,
			terminalId: "terminal-1",
			forwardUserInput,
		});

		helper.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				inputType: "insertText",
				data: "か",
			}),
		);
		helper.value = "か";
		fireEvent.input(helper);
		helper.value = "が";
		fireEvent.input(helper);

		expect(forwardUserInput.mock.calls).toEqual([["か"], ["\x7fが"]]);
		expect(helper.value).toBe("が");
		dispose();
	});

	it("leaves ordinary keydown-backed text input to the terminal", () => {
		const host = document.createElement("div");
		const helper = document.createElement("textarea");
		host.append(helper);
		const forwardUserInput = vi.fn(async () => {});
		const bubbledInput = vi.fn();
		host.addEventListener("input", bubbledInput);
		const dispose = installTerminalReplacementInput({
			input: helper,
			terminalId: "terminal-1",
			forwardUserInput,
		});

		fireEvent.keyDown(helper, { key: "a", code: "KeyA", keyCode: 65 });
		helper.dispatchEvent(
			new InputEvent("beforeinput", {
				bubbles: true,
				inputType: "insertText",
				data: "a",
			}),
		);
		helper.value = "a";
		fireEvent.input(helper);

		expect(forwardUserInput).not.toHaveBeenCalled();
		expect(bubbledInput).toHaveBeenCalledOnce();
		dispose();
	});
});
