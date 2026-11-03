import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	backgroundWorkHiddenCount,
	backgroundWorkRows,
	backgroundWorkSummary,
} from "@/lib/agents/chat/backgroundWork";
import { setLang } from "@/lib/i18n";
import type {
	BackgroundWorkItem,
	BackgroundWorkList,
} from "@/lib/ipc/conversations";

// English is the canonical copy these cases spell out.
beforeAll(() => setLang("en"));
afterAll(() => setLang("ko"));

const NOW = 1_793_600_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function list(
	items: BackgroundWorkItem[],
	counts: Partial<BackgroundWorkList["counts"]> = {},
	truncated = false,
): BackgroundWorkList {
	return {
		items,
		counts: { subagents: 0, workflows: 0, shells: 0, monitors: 0, ...counts },
		truncated,
	};
}

describe("backgroundWorkSummary", () => {
	it("hides the line when nothing runs", () => {
		expect(backgroundWorkSummary(list([]))).toBeNull();
	});

	it("counts subagents and workflows as running, then shells and monitors", () => {
		expect(
			backgroundWorkSummary(
				list([], { subagents: 2, workflows: 9, shells: 4, monitors: 5 }),
			),
		).toBe("11 running · 4 shells · 5 monitors");
	});

	it("leaves out kinds with nothing running", () => {
		expect(backgroundWorkSummary(list([], { shells: 1 }))).toBe("1 shell");
		expect(backgroundWorkSummary(list([], { workflows: 1, monitors: 2 }))).toBe(
			"1 running · 2 monitors",
		);
	});
});

describe("backgroundWorkRows", () => {
	it("formats steps, elapsed time and tokens", () => {
		const [row] = backgroundWorkRows(
			list([
				{
					id: "wf_1",
					kind: "workflow",
					label: "typing-accuracy-first",
					startedUnixMs: NOW - (16 * HOUR + 35 * MINUTE),
					steps: { done: 9, total: 10 },
					tokens: 4_700_000,
				},
			]),
			NOW,
		);
		expect(row).toEqual({
			id: "wf_1",
			kind: "workflow",
			label: "typing-accuracy-first",
			progress: 0.9,
			steps: "9/10",
			elapsed: "16h35m",
			tokens: "4.7M",
		});
	});

	it("rounds short durations and small token counts", () => {
		const rows = backgroundWorkRows(
			list([
				{
					id: "a",
					kind: "subagent",
					startedUnixMs: NOW - 45_000,
					tokens: 175_300,
				},
				{
					id: "b",
					kind: "subagent",
					startedUnixMs: NOW - 34 * MINUTE - 35_000,
					tokens: 950,
				},
				{
					id: "c",
					kind: "workflow",
					startedUnixMs: NOW - HOUR,
					tokens: 1_300_000,
				},
			]),
			NOW,
		);
		expect(rows.map((row) => [row.elapsed, row.tokens])).toEqual([
			["45s", "175k"],
			["34m", "950"],
			["1h00m", "1.3M"],
		]);
	});

	it("shows no bar, steps or tokens when the provider did not record them", () => {
		const [row] = backgroundWorkRows(
			list([
				{
					id: "s",
					kind: "shell",
					label: "Watch CI",
					startedUnixMs: NOW - 5_000,
				},
			]),
			NOW,
		);
		expect(row.progress).toBeNull();
		expect(row.steps).toBeNull();
		expect(row.tokens).toBeNull();
	});

	it("names an item without a description by its kind", () => {
		const rows = backgroundWorkRows(
			list([
				{ id: "s", kind: "shell", startedUnixMs: NOW },
				{ id: "m", kind: "monitor", startedUnixMs: NOW },
			]),
			NOW,
		);
		expect(rows.map((row) => row.label)).toEqual(["Shell", "Monitor"]);
	});

	it("never shows a negative elapsed time for a clock ahead of this one", () => {
		const [row] = backgroundWorkRows(
			list([{ id: "s", kind: "shell", startedUnixMs: NOW + 10_000 }]),
			NOW,
		);
		expect(row.elapsed).toBe("0s");
	});
});

describe("backgroundWorkHiddenCount", () => {
	it("counts what a truncated list left out", () => {
		const items: BackgroundWorkItem[] = [
			{ id: "a", kind: "shell", startedUnixMs: NOW },
			{ id: "b", kind: "shell", startedUnixMs: NOW },
		];
		expect(backgroundWorkHiddenCount(list(items, { shells: 70 }, true))).toBe(
			68,
		);
		expect(backgroundWorkHiddenCount(list(items, { shells: 2 }))).toBe(0);
	});
});
