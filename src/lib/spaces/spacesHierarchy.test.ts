import { describe, expect, it } from "vitest";
import type { NeedsPersonReason } from "@/lib/agents/needsPerson";
import {
	bucketVisibleSpaces,
	leadWorkerRowKeys,
	leadWorkersFoldKey,
	nestLeadWorkers,
	orderDesktopsWithPopouts,
	partitionSpacesByPins,
	selectableRowKeys,
} from "@/lib/spaces/spacesHierarchy";

interface Row {
	readonly key: string;
	readonly desktopId: string;
	readonly projectId?: string;
	readonly projectName: string;
	readonly hostId?: string;
	readonly displayState?: string;
	readonly needsPerson?: NeedsPersonReason;
	readonly programStatusKind?: string;
}

it("partitions pane pins before repository pins using exact desktop identity", () => {
	const first = { key: "agent:a", desktopId: "d1", projectId: "alpha", projectName: "Alpha" };
	const otherDesktop = { ...first, desktopId: "d2" };
	const ordinary = { key: "term:b", desktopId: "d1", projectName: "Local" };
	const pins = { "d1:agent:a": true, "d1:term:b": false, "d1:missing": true };
	expect(partitionSpacesByPins(
		[first, otherDesktop, ordinary], pins, new Set(['["project","alpha"]']),
	)).toEqual({ panes: [first], repositories: [otherDesktop], body: [ordinary] });
});

describe("bucketVisibleSpaces", () => {
	const rows: Row[] = [
		{
			key: "a",
			desktopId: "d1",
			projectId: "alpha",
			projectName: "Alpha",
			displayState: "blocked",
			needsPerson: "approval",
		},
		{
			key: "b",
			desktopId: "d1",
			projectId: "beta",
			projectName: "Beta",
			displayState: "working",
		},
		{
			key: "c",
			desktopId: "d2",
			projectId: "alpha",
			projectName: "Alpha",
			displayState: "input",
			needsPerson: "input",
		},
		{ key: "d", desktopId: "d2", projectName: "로컬" },
	];

	it("buckets only visible rows per desktop while keeping pane order", () => {
		const { visibleByDesktop } = bucketVisibleSpaces(
			rows,
			(row) => row.key !== "c",
		);
		expect(
			[...visibleByDesktop.entries()].map(([id, bucket]) => [
				id,
				bucket.map((row) => row.key),
			]),
		).toEqual([
			["d1", ["a", "b"]],
			["d2", ["d"]],
		]);
	});

	it("rolls attention up per desktop and per repository regardless of visibility", () => {
		const { attentionByDesktop, attentionByRepository } = bucketVisibleSpaces(
			rows,
			() => false,
		);
		expect([...attentionByDesktop.entries()]).toEqual([
			["d1", 1],
			["d2", 1],
		]);
		expect([...attentionByRepository.entries()]).toEqual([
			['["project","alpha"]', 2],
		]);
	});

	it("counts the rows the needs-person authority flagged, an unexpected exit included", () => {
		const flagged: Row[] = [
			{
				key: "crashed",
				desktopId: "d1",
				projectId: "alpha",
				projectName: "Alpha",
				displayState: "exited",
				needsPerson: "unexpected_exit",
			},
			{
				key: "stopped",
				desktopId: "d1",
				projectId: "alpha",
				projectName: "Alpha",
				displayState: "exited",
			},
			// The rollup reads the authority's verdict, never a display state.
			{
				key: "unflagged",
				desktopId: "d1",
				projectId: "alpha",
				projectName: "Alpha",
				displayState: "blocked",
			},
		];
		const buckets = bucketVisibleSpaces(flagged, () => false);
		expect([...buckets.attentionByDesktop.entries()]).toEqual([["d1", 1]]);
		expect([...buckets.attentionByRepository.entries()]).toEqual([
			['["project","alpha"]', 1],
		]);
	});

	it("rolls a program's waiting report up beside attention without counting a row twice", () => {
		const reporting: Row[] = [
			{
				key: "terminal",
				desktopId: "d1",
				projectId: "alpha",
				projectName: "Alpha",
				displayState: "waiting",
				programStatusKind: "permission",
			},
			{
				key: "already-attention",
				desktopId: "d1",
				projectId: "alpha",
				projectName: "Alpha",
				displayState: "blocked",
				needsPerson: "approval",
				programStatusKind: "question",
			},
			{
				key: "plain-shell",
				desktopId: "d2",
				projectName: "Local",
				programStatusKind: "auth",
			},
		];
		const buckets = bucketVisibleSpaces(reporting, () => false);
		expect([...buckets.programStatusByDesktop.entries()]).toEqual([
			["d1", 1],
			["d2", 1],
		]);
		expect(buckets.programStatusByRepository.get('["project","alpha"]')).toBe(1);
		expect([...buckets.attentionByDesktop.entries()]).toEqual([["d1", 1]]);
		expect(buckets.attentionByRepository.get('["project","alpha"]')).toBe(1);
	});
});

describe("orderDesktopsWithPopouts", () => {
	it("nests popouts after their origin and trails orphaned ones", () => {
		const desktops = [
			{ id: "p-orphan", kind: "popout" as const, originSpaceId: "gone" },
			{ id: "one" },
			{ id: "two" },
			{ id: "p-one", kind: "popout" as const, originSpaceId: "one" },
		];
		expect(orderDesktopsWithPopouts(desktops).map((d) => d.id)).toEqual([
			"one",
			"p-one",
			"two",
			"p-orphan",
		]);
	});
});

describe("selectableRowKeys", () => {
	const buckets = [
		{ key: "alpha", spaces: [{ key: "a1" }, { key: "a2" }] },
		{ key: "beta", spaces: [{ key: "b1" }] },
		{ key: "gamma", spaces: [{ key: "c1" }] },
	];

	it("walks the rendered rows in visual order", () => {
		expect(selectableRowKeys(buckets, {})).toEqual(["a1", "a2", "b1", "c1"]);
	});

	it("skips the rows behind a folded repository so a range cannot reach them", () => {
		expect(selectableRowKeys(buckets, { beta: true })).toEqual(["a1", "a2", "c1"]);
	});

	it("keeps the focused row, which a folded repository still shows", () => {
		expect(selectableRowKeys(buckets, { beta: true }, "b1")).toEqual([
			"a1",
			"a2",
			"b1",
			"c1",
		]);
	});
});

describe("nestLeadWorkers", () => {
	const lead = { key: "p-lead", desktopId: "d1", relationKey: "lead" };
	// Dockview order differs from start order on purpose.
	const second = { key: "p-2", desktopId: "d1", relationKey: "w2", leadKey: "lead", workerOrder: 2 };
	const plain = { key: "p-plain", desktopId: "d1", relationKey: "solo" };
	const third = { key: "p-3", desktopId: "d1", relationKey: "w3", leadKey: "lead", workerOrder: 3 };
	const first = { key: "p-1", desktopId: "d1", relationKey: "w1", leadKey: "lead", workerOrder: 1 };
	const terminal = { key: "term", desktopId: "d1" };

	it("lifts a lead's workers under it in start order and keeps every other row in place", () => {
		expect(
			nestLeadWorkers([second, lead, plain, third, terminal, first]).map(
				({ row, workers }) => [row.key, workers.map((worker) => worker.key)],
			),
		).toEqual([
			["p-lead", ["p-1", "p-2", "p-3"]],
			["p-plain", []],
			["term", []],
		]);
	});

	it("leaves rows without a lead exactly as they came", () => {
		const rows = [plain, terminal, lead];
		expect(nestLeadWorkers(rows).map(({ row, workers }) => [row, workers.length])).toEqual([
			[plain, 0],
			[terminal, 0],
			[lead, 0],
		]);
	});

	it("keeps a worker in place when its lead is in another space or another list", () => {
		const elsewhere = { ...first, desktopId: "d2" };
		expect(nestLeadWorkers([lead, elsewhere]).map(({ row }) => row.key)).toEqual([
			"p-lead",
			"p-1",
		]);
		expect(nestLeadWorkers([first, plain]).map(({ row }) => row.key)).toEqual([
			"p-1",
			"p-plain",
		]);
	});

	it("nests one step only and never loops on a cycle", () => {
		const grandchild = { key: "p-g", desktopId: "d1", relationKey: "g", leadKey: "w1", workerOrder: 4 };
		expect(
			nestLeadWorkers([lead, first, grandchild]).map(({ row, workers }) => [
				row.key,
				workers.map((worker) => worker.key),
			]),
		).toEqual([
			["p-lead", ["p-1"]],
			["p-g", []],
		]);
		const a = { key: "a", desktopId: "d1", relationKey: "a", leadKey: "b" };
		const b = { key: "b", desktopId: "d1", relationKey: "b", leadKey: "a" };
		expect(nestLeadWorkers([a, b]).map(({ row, workers }) => [row.key, workers.length])).toEqual([
			["a", 0],
			["b", 0],
		]);
	});

	it("nests the Agents started from a plain shell under that shell's row", () => {
		const shell = { key: "p-shell", desktopId: "d1", relationKey: "pane:d1:p-shell" };
		const worker = { ...first, leadKey: shell.relationKey };
		expect(
			nestLeadWorkers([worker, shell, plain]).map(({ row, workers }) => [
				row.key,
				workers.map((entry) => entry.key),
			]),
		).toEqual([
			["p-shell", ["p-1"]],
			["p-plain", []],
		]);
		const folded = { [leadWorkersFoldKey(shell.relationKey)]: true as const };
		expect(leadWorkerRowKeys([worker, shell], folded)).toEqual(["p-shell"]);
	});

	it("orders selection as drawn, and a closed fold keeps only the focused worker", () => {
		const rows = [second, lead, plain, first];
		expect(leadWorkerRowKeys(rows, {})).toEqual(["p-lead", "p-1", "p-2", "p-plain"]);
		const folded = { [leadWorkersFoldKey("lead")]: true as const };
		expect(leadWorkerRowKeys(rows, folded)).toEqual(["p-lead", "p-plain"]);
		expect(leadWorkerRowKeys(rows, folded, "p-2")).toEqual(["p-lead", "p-2", "p-plain"]);
		expect(selectableRowKeys([{ key: "alpha", spaces: rows }], {})).toEqual([
			"p-lead",
			"p-1",
			"p-2",
			"p-plain",
		]);
	});
});
