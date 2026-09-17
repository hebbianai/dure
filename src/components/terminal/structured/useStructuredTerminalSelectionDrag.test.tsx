// @vitest-environment jsdom

import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewportFrame } from "@/contracts/terminalStateProtocol";
import { decodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";
import { useStructuredTerminalSelectionDrag } from "./useStructuredTerminalSelectionDrag";

function frame(first: number, appliedIntentSeq = 0n): ViewportFrame {
	const { record } = decodeTerminalStateRecord(
		viewportFrameRecord({
			texts: Array.from({ length: 5 }, (_, i) => `line ${first + i}`),
			logicalLineIds: Array.from({ length: 5 }, (_, i) => BigInt(first + i)),
			projectionRevision: appliedIntentSeq * 2n + 1n,
			appliedIntentSeq,
			followTail: false,
			hasMoreBefore: first > 1,
			hasMoreAfter: first < 10,
		}),
	);
	if (record.body.case !== "viewportFrame") throw new Error("expected frame");
	return record.body.value;
}

const animationFrames = new Map<number, FrameRequestCallback>();
beforeEach(() => {
	let next = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		animationFrames.set(++next, callback);
		return next;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) =>
		animationFrames.delete(id),
	);
});
afterEach(() => {
	animationFrames.clear();
	vi.unstubAllGlobals();
});

function tick() {
	act(() => {
		const pending = [...animationFrames.values()];
		animationFrames.clear();
		for (const callback of pending) callback(0);
	});
}

function startDrag(clientY: number) {
	const surface = document.createElement("div");
	surface.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
	const scrollRows = vi.fn((_: number): bigint | undefined =>
		BigInt(scrollRows.mock.calls.length),
	);
	const onCommit = vi.fn();
	const initialProps = {
		frame: frame(5),
		enabled: true,
		attachmentIdentity: "pane-a:epoch-a",
	};
	const hook = renderHook(
		(props: typeof initialProps) =>
			useStructuredTerminalSelectionDrag({
				...props,
				terminalSurfaceRef: { current: surface },
				readMetrics: () => ({ cellWidth: 10, rowHeight: 20 }),
				scrollRows,
				onStart: vi.fn(),
				onClick: vi.fn(),
				onCommit,
			}),
		{ initialProps },
	);
	act(() => {
		hook.result.current.begin(
			new PointerEvent("pointerdown", {
				pointerId: 1,
				button: 0,
				buttons: 1,
				clientX: 0,
				clientY: 50,
			}),
			false,
		);
	});
	const move = (y: number, buttons = 1) =>
		fireEvent.pointerMove(window, {
			pointerId: 1,
			buttons,
			clientX: y < 50 ? 0 : 60,
			clientY: y,
		});
	move(clientY);
	return { ...hook, scrollRows, onCommit, move, initialProps };
}

describe("selection drag edge scrolling", () => {
	it.each([
		{
			edge: "top",
			y: 1,
			rows: 1,
			first: 4,
			text: "line 2\nline 3\nline 4\nline 5\nline 6",
		},
		{
			edge: "bottom",
			y: 99,
			rows: -1,
			first: 6,
			text: "line 7\nline 8\nline 9\nline 10\nline 11\nline 12",
		},
	])(
		"keeps scrolling at the inside $edge edge and retains offscreen text",
		({ y, rows, first, text }) => {
			const drag = startDrag(y);
			tick();
			expect(drag.scrollRows).toHaveBeenCalledExactlyOnceWith(rows);
			tick();
			expect(drag.scrollRows).toHaveBeenCalledTimes(1);
			// Unacknowledged output must not start another viewport request.
			drag.rerender({
				...drag.initialProps,
				frame: { ...frame(5), projectionRevision: 2n },
			});
			tick();
			expect(drag.scrollRows).toHaveBeenCalledTimes(1);
			for (let seq = 1n; seq <= 3n; seq += 1n) {
				drag.rerender({
					...drag.initialProps,
					frame: frame(first - rows * (Number(seq) - 1), seq),
				});
				tick();
				expect(drag.scrollRows.mock.calls).toEqual(
					Array(Number(seq) + 1).fill([rows]),
				);
			}
			fireEvent.pointerUp(window, {
				pointerId: 1,
				buttons: 0,
				clientX: y < 50 ? 0 : 60,
				clientY: y,
			});
			tick();
			expect(drag.onCommit).toHaveBeenCalledExactlyOnceWith(text);
			expect(drag.result.current.selectedText()).toBe(text);
			drag.rerender({
				...drag.initialProps,
				frame: frame(first - rows * 3, 4n),
			});
			tick();
			expect(drag.scrollRows).toHaveBeenCalledTimes(4);
		},
	);

	it.each(["release", "cancel", "blur", "unmount", "attachment", "disable"])(
		"retires the pending scroll on %s",
		(reason) => {
			const drag = startDrag(99);
			tick();
			expect(drag.scrollRows).toHaveBeenCalledTimes(1);
			drag.rerender({ ...drag.initialProps, frame: frame(6, 1n) });
			if (reason === "release") drag.move(99, 0);
			if (reason === "cancel")
				fireEvent.pointerCancel(window, { pointerId: 1 });
			if (reason === "blur") fireEvent.blur(window);
			if (reason === "unmount") drag.unmount();
			if (reason === "attachment")
				drag.rerender({
					...drag.initialProps,
					attachmentIdentity: "pane-b:epoch-b",
				});
			if (reason === "disable")
				drag.rerender({ ...drag.initialProps, enabled: false });
			tick();
			expect(drag.scrollRows).toHaveBeenCalledTimes(1);
		},
	);

	it("stops when the pointer returns inside before the Host acknowledgement", () => {
		const drag = startDrag(99);
		tick();
		drag.move(60);
		drag.rerender({ ...drag.initialProps, frame: frame(6, 1n) });
		tick();
		expect(drag.scrollRows).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ y: 1, first: 1 },
		{ y: 99, first: 10 },
	])("stops at the Host history boundary ($first)", ({ y, first }) => {
		const drag = startDrag(y);
		drag.rerender({ ...drag.initialProps, frame: frame(first) });
		tick();
		expect(drag.scrollRows).not.toHaveBeenCalled();
	});
});
