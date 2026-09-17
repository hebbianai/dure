import { expect, it } from "vitest";
import { showTerminalScrollToBottom } from "./terminalScrollToBottom";

it("keeps return available when output or resize invalidates the exact distance", () => {
	const frame = {
		followTail: false,
		hasMoreAfter: true,
		rowsFromTail: 20n,
		viewportRows: 20,
	};
	expect(showTerminalScrollToBottom(null)).toBe(false);
	for (const projection of [
		frame,
		{ ...frame, rowsFromTail: undefined },
		{ ...frame, rowsFromTail: 1n },
		{ ...frame, viewportRows: 40 },
	]) {
		expect(showTerminalScrollToBottom(projection)).toBe(true);
	}
	for (const projection of [
		{
			...frame,
			followTail: true,
			rowsFromTail: 0n,
			hasMoreAfter: false,
		},
		{ ...frame, hasMoreAfter: false },
		{ ...frame, followTail: true },
		{ ...frame, rowsFromTail: undefined, hasMoreAfter: false },
	]) {
		expect(showTerminalScrollToBottom(projection)).toBe(false);
	}
});
