// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CodeEditor } from "@/components/editor/CodeEditor";

// jsdom does no layout; CodeMirror measures text ranges when it scrolls.
beforeAll(() => {
	Range.prototype.getClientRects = () =>
		Object.assign([], { item: () => null }) as unknown as DOMRectList;
	Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(cleanup);

describe("CodeEditor reveal", () => {
	it("puts the cursor on the requested line and column once per request", async () => {
		const onCursor = vi.fn();
		const onRevealed = vi.fn();
		const view = render(
			<CodeEditor
				value={"one\ntwo\nthree"}
				fileName="notes.txt"
				onCursor={onCursor}
				reveal={{ id: 1, line: 2, column: 3 }}
				onRevealed={onRevealed}
			/>,
		);
		await waitFor(() => expect(onRevealed).toHaveBeenCalledWith(1));
		expect(onCursor).toHaveBeenLastCalledWith(2, 3);

		view.rerender(
			<CodeEditor
				value={"one\ntwo\nthree"}
				fileName="notes.txt"
				onCursor={onCursor}
				reveal={{ id: 2, line: 99, column: 99 }}
				onRevealed={onRevealed}
			/>,
		);
		await waitFor(() => expect(onRevealed).toHaveBeenCalledWith(2));
		expect(onCursor).toHaveBeenLastCalledWith(3, 6);
		expect(onRevealed).toHaveBeenCalledTimes(2);
	});
});
