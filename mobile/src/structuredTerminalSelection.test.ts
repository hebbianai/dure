import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";
import { mountStructuredTerminal } from "./structuredTerminal";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));

beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
	document.getSelection()?.removeAllRanges();
});

describe("selection on the displayed mobile terminal", () => {
	it.each([true, false])(
		"copies the native Korean selection after redraw without focusing input (writable=%s)",
		async (writable) => {
			const host = document.createElement("div");
			document.body.append(host);
			let nextFrame: ((record: ArrayBuffer) => void) | undefined;
			let first = true;
			const frame = (revision: bigint, last: string) =>
				viewportFrameRecord({
					terminalEpoch: "selection-epoch",
					projectionRevision: revision,
					texts: ["before", "한글 선택", last],
					logicalLineIds: [1n, 2n, 3n],
				}).buffer as ArrayBuffer;
			const focusField = vi.fn(() => true);
			const surface = mountStructuredTerminal(
				host,
				{
					attachment_id: "selection-test",
					terminal_epoch: "selection-epoch",
					through_output_seq: "1",
					state_revision: "1",
					initial_delivery_record_count: 1,
				},
				{
					next: async () => {
						if (!first)
							return new Promise((resolve) => {
								nextFrame = resolve;
							});
						first = false;
						return frame(1n, "after");
					},
					send: async () => {},
				},
				{ focusField, writable },
			);
			try {
				await vi.waitFor(() => expect(host.textContent).toContain("한글 선택"));
				const selection = document.getSelection()!;
				// Native handles adjust the browser Range on the rendered text itself.
				const row = host.querySelectorAll(".terminal-viewport-row")[1];
				const runs = row.querySelectorAll("[data-terminal-run]");
				selection.setBaseAndExtent(
					runs[0].firstChild!,
					0,
					runs[1].firstChild!,
					1,
				);
				expect(selection.toString()).toBe("한글");
				host.click();
				expect(focusField).not.toHaveBeenCalled();
				nextFrame!(frame(2n, "new output"));
				await vi.waitFor(() =>
					expect(host.textContent).toContain("new output"),
				);
				expect(selection.toString()).toBe("한글");
				const nativeCopy = new Event("copy", {
					bubbles: true,
					cancelable: true,
				});
				const setData = vi.fn();
				Object.defineProperty(nativeCopy, "clipboardData", {
					value: { setData },
				});
				host.dispatchEvent(nativeCopy);
				expect(nativeCopy.defaultPrevented).toBe(true);
				expect(setData).toHaveBeenCalledExactlyOnceWith("text/plain", "한글");
				expect(selection.toString()).toBe("한글");
				expect(document.querySelector('[role="dialog"]')).toBeNull();
				selection.removeAllRanges();
				const noSelection = new Event("copy", {
					bubbles: true,
					cancelable: true,
				});
				host.dispatchEvent(noSelection);
				expect(noSelection.defaultPrevented).toBe(false);
				host.click();
				expect(focusField).toHaveBeenCalledTimes(writable ? 1 : 0);
			} finally {
				surface.dispose();
				host.remove();
			}
		},
	);
});
