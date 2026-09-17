import { describe, expect, it } from "vitest";
import { terminalTextReplacement } from "./terminalTextReplacement";

describe("terminal text-service edits", () => {
	it("revises a Korean syllable while retaining the preceding prompt", () => {
		expect(terminalTextReplacement("한ㄱ", "한그")).toEqual({
			deleteBefore: 1,
			text: "그",
		});
		expect(terminalTextReplacement("한그", "한글")).toEqual({
			deleteBefore: 1,
			text: "글",
		});
	});
	it("erases an emoji with one terminal Backspace and never sends a surrogate half", () => {
		expect(terminalTextReplacement("한글😀", "한글")).toEqual({
			deleteBefore: 1,
			text: "",
		});
	});
});
