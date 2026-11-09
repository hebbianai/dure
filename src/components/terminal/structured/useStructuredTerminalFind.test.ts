// @vitest-environment jsdom

import { create } from "@bufbuild/protobuf";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	FindStatus,
	FindStep,
	ViewportFindSchema,
	type ViewportFrame,
	ViewportFrameSchema,
} from "@/contracts/terminalStateProtocol";
import { TERMINAL_FIND_DEBOUNCE_MS } from "@/lib/terminal/interaction/terminalFind";
import { TERMINAL_HISTORY_FIND_CAPABILITY } from "@/lib/terminal/protocol/terminalStateLimits";
import { decodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import type { StructuredTerminalViewportTransport } from "./structuredTerminalViewportTransportContract";
import { useStructuredTerminalFind } from "./useStructuredTerminalFind";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

interface SentFind {
	readonly query: string;
	readonly caseSensitive: boolean;
	readonly regex: boolean;
	readonly step: FindStep;
}

function harness(supported = true) {
	const sent: SentFind[] = [];
	let intentSeq = 0n;
	const sendViewportIntent = vi.fn(
		(
			encode: Parameters<
				StructuredTerminalViewportTransport["sendViewportIntent"]
			>[0],
		) => {
			intentSeq += 1n;
			const decoded = decodeTerminalStateRecord(
				encode(
					intentSeq,
					{
						schemaMinor: 4,
						terminalEpoch: "terminal-a",
						throughOutputSeq: 1n,
						stateRevision: 1n,
					},
					{
						attachmentId: "attachment-a",
						observedProjectionRevision: 3n,
						intentSeq,
					},
				),
			);
			const body = decoded.record.body;
			if (
				body.case !== "viewportIntent" ||
				body.value.intent.case !== "findInHistory"
			) {
				throw new Error("expected a find intent");
			}
			const { query, caseSensitive, regex, step } = body.value.intent.value;
			sent.push({ query, caseSensitive, regex, step });
			return intentSeq;
		},
	);
	const focusTerminal = vi.fn();
	const frame = (find?: ViewportFrame["find"]) =>
		create(ViewportFrameSchema, { projectionRevision: 3n, find });
	const view = renderHook(
		({ current }: { current: ViewportFrame | null }) =>
			useStructuredTerminalFind(
				{
					replica: {
						attachmentId: "attachment-a",
					} as StructuredTerminalViewportTransport["replica"],
					sendViewportIntent,
					supportsCapability: (capability) =>
						supported && capability === TERMINAL_HISTORY_FIND_CAPABILITY,
				},
				current,
				focusTerminal,
			),
		{ initialProps: { current: frame() } },
	);
	return { sent, view, frame, focusTerminal };
}

it("searches after typing pauses and shows the Host's answer only once it arrives", () => {
	const { sent, view, frame } = harness();
	act(() => view.result.current.show());
	act(() => view.result.current.setQuery("err"));
	act(() => view.result.current.setQuery("error"));
	expect(sent).toEqual([]);
	expect(view.result.current.summary).toEqual({ kind: "searching" });

	act(() => vi.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS));
	expect(sent).toEqual([
		{
			query: "error",
			caseSensitive: false,
			regex: false,
			step: FindStep.RESTART,
		},
	]);
	expect(view.result.current.summary).toEqual({ kind: "searching" });

	view.rerender({
		current: frame(
			create(ViewportFindSchema, {
				findIntentSeq: 1n,
				status: FindStatus.MATCHED,
				matchCount: 4,
				matchCountComplete: true,
				currentMatch: 1,
			}),
		),
	});
	expect(view.result.current.summary).toEqual({
		kind: "matched",
		current: 1,
		total: 4,
		complete: true,
	});
});

it("steps from the current match, and restarts when an edit is still pending", () => {
	const { sent, view } = harness();
	act(() => view.result.current.show());
	act(() => view.result.current.setQuery("warn"));
	act(() => vi.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS));
	act(() => view.result.current.step(FindStep.OLDER));
	act(() => view.result.current.step(FindStep.NEWER));
	act(() => view.result.current.toggleCaseSensitive());
	act(() => view.result.current.step(FindStep.OLDER));
	expect(sent.map((find) => [find.step, find.caseSensitive])).toEqual([
		[FindStep.RESTART, false],
		[FindStep.OLDER, false],
		[FindStep.NEWER, false],
		[FindStep.RESTART, true],
	]);
	// The flushed edit does not search a second time when the pause ends.
	act(() => vi.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS));
	expect(sent).toHaveLength(4);
});

it("ends the Host find and returns focus to the terminal when closed", () => {
	const { sent, view, focusTerminal } = harness();
	act(() => view.result.current.show());
	act(() => view.result.current.setQuery("x"));
	act(() => vi.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS));
	act(() => view.result.current.close());
	expect(sent[sent.length - 1]).toEqual({
		query: "",
		caseSensitive: false,
		regex: false,
		step: FindStep.RESTART,
	});
	expect(view.result.current.open).toBe(false);
	expect(focusTerminal).toHaveBeenCalledTimes(1);
});

it("sends nothing to a Host without history find and says how to get it", () => {
	const { sent, view } = harness(false);
	act(() => view.result.current.show());
	act(() => view.result.current.setQuery("x"));
	act(() => vi.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS));
	act(() => view.result.current.step(FindStep.OLDER));
	expect(sent).toEqual([]);
	expect(view.result.current.summary).toEqual({ kind: "unsupported" });
});
