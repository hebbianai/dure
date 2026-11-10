import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	backgroundWorkHiddenCount,
	backgroundWorkRows,
	backgroundWorkSession,
	backgroundWorkSummary,
	subagentsAsBackgroundWork,
} from "@/lib/agents/chat/backgroundWork";
import type { ProviderConversationSubagent } from "@/lib/agents/providerConversationDiscovery";
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

describe("backgroundWorkSession", () => {
	it("reads only an agent's own local managed session", () => {
		expect(
			backgroundWorkSession({
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "local",
				hostId: "local",
				workspaceId: "workspace-1",
				sessionId: "session-1",
			}),
		).toEqual({ workspaceId: "workspace-1", sessionId: "session-1" });
		expect(
			backgroundWorkSession({
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "box",
				workspaceId: "workspace-1",
				sessionId: "session-1",
				createIdempotencyKey: "create-1",
				commandBridgeNonce: "nonce-1",
			}),
		).toBeNull();
		expect(backgroundWorkSession(undefined)).toBeNull();
	});
});

describe("subagentsAsBackgroundWork", () => {
	const row = (
		id: string,
		status: ProviderConversationSubagent["status"],
		toolUseId?: string,
	): ProviderConversationSubagent => ({
		id,
		title: id,
		status,
		mtime: 1,
		...(toolUseId ? { toolUseId } : {}),
	});
	const subagent = (id: string): BackgroundWorkItem => ({
		id,
		kind: "subagent",
		startedUnixMs: NOW,
	});

	it("runs exactly the rows the line's list names", () => {
		const rows = subagentsAsBackgroundWork(
			[
				// A background subagent the line lists by its agent id, though
				// its file has been quiet for longer than any activity window.
				row("agent-a1", "unknown"),
				// A foreground subagent the turn still waits on, listed by the
				// call that started it.
				row("agent-a2", "unknown", "toolu_02"),
				// Its meta says finished, so the line no longer lists it.
				row("agent-a3", "completed", "toolu_03"),
				row("agent-a4", "failed"),
			],
			list([subagent("a1"), subagent("toolu_02")], { subagents: 2 }),
		);
		expect(rows.map((entry) => [entry.id, entry.status])).toEqual([
			["agent-a1", "running"],
			["agent-a2", "running"],
			["agent-a3", "completed"],
			["agent-a4", "failed"],
		]);
	});

	it("does not take another kind's id for a subagent", () => {
		const rows = subagentsAsBackgroundWork(
			[row("agent-a1", "unknown", "toolu_01")],
			list(
				[
					{ id: "toolu_01", kind: "shell", startedUnixMs: NOW },
					{ id: "a1", kind: "workflow", startedUnixMs: NOW },
				],
				{ shells: 1, workflows: 1 },
			),
		);
		expect(rows[0]?.status).toBe("unknown");
	});

	it("keeps the recorded rows without a list", () => {
		const rows = [row("agent-a1", "unknown"), row("agent-a2", "completed")];
		expect(subagentsAsBackgroundWork(rows, null)).toEqual(rows);
	});
});
