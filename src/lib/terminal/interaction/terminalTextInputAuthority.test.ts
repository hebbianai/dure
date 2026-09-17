import { describe, expect, it } from "vitest";
import {
	terminalTextInputAuthorityIsCurrent,
	terminalTextInputMayForward,
} from "./terminalTextInputAuthority";

describe("terminal text input authority", () => {
	it("requires both the current attachment and exact keyboard owner", () => {
		expect(
			terminalTextInputAuthorityIsCurrent({
				attachmentCurrent: true,
				keyboardOwnerCurrent: true,
			}),
		).toBe(true);
		for (const authority of [
			{ attachmentCurrent: false, keyboardOwnerCurrent: true },
			{ attachmentCurrent: true, keyboardOwnerCurrent: false },
			{ attachmentCurrent: false, keyboardOwnerCurrent: false },
		]) {
			expect(terminalTextInputAuthorityIsCurrent(authority)).toBe(false);
		}
	});

	it("never turns an empty browser event into a terminal text intent", () => {
		const current = {
			attachmentCurrent: true,
			keyboardOwnerCurrent: true,
		};

		expect(terminalTextInputMayForward(current, "design-labs")).toBe(true);
		expect(terminalTextInputMayForward(current, "")).toBe(false);
		expect(
			terminalTextInputMayForward(
				{ ...current, keyboardOwnerCurrent: false },
				"design-labs",
			),
		).toBe(false);
	});
});
