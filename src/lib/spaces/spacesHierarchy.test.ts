import { describe, expect, it } from "vitest";
import {
	bucketVisibleSpaces,
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
