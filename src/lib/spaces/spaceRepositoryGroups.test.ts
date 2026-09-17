import { describe, expect, it } from "vitest";
import {
	withRegisteredRepositories,
	groupSpacesByRepository,
	groupSpacesByRepositoryAcrossDesktops,
	repositoryRemoteHostId,
	spaceRepositoryGroupKey,
} from "@/lib/spaces/spaceRepositoryGroups";

interface Row {
	readonly key: string;
	readonly projectId?: string;
	readonly projectName: string;
	readonly hostId?: string;
}

describe("groupSpacesByRepository", () => {
	it("groups by project identity while preserving first-group and pane order", () => {
		const rows: Row[] = [
			{ key: "alpha-1", projectId: "alpha", projectName: "Alpha" },
			{ key: "beta-1", projectId: "beta", projectName: "Beta" },
			{ key: "alpha-2", projectId: "alpha", projectName: "Alpha" },
		];

		expect(groupSpacesByRepository(rows)).toEqual([
			{
				key: '["project","alpha"]',
				label: "Alpha",
				projectId: "alpha",
				spaces: [rows[0], rows[2]],
			},
			{
				key: '["project","beta"]',
				label: "Beta",
				projectId: "beta",
				spaces: [rows[1]],
			},
		]);
	});

	it("does not merge repositories that happen to share a display name", () => {
		const groups = groupSpacesByRepository([
			{ key: "local", projectId: "local-app", projectName: "app" },
			{ key: "remote", projectId: "remote-app", projectName: "app" },
		] satisfies Row[]);

		expect(groups).toHaveLength(2);
		expect(groups.map((group) => group.spaces[0]?.key)).toEqual([
			"local",
			"remote",
		]);
	});

	it("uses host and location label as the safe fallback for unregistered panes", () => {
		const groups = groupSpacesByRepository([
			{ key: "local-1", projectName: "로컬" },
			{ key: "remote-1", projectName: "work", hostId: "host-a" },
			{ key: "local-2", projectName: "로컬" },
			{ key: "remote-2", projectName: "work", hostId: "host-b" },
		] satisfies Row[]);

		expect(groups.map((group) => group.spaces.map((row) => row.key))).toEqual([
			["local-1", "local-2"],
			["remote-1"],
			["remote-2"],
		]);
	});
});
describe("repositoryRemoteHostId", () => {
	const remoteProject = { id: "remote-app", sshHostId: "host-a" };
	const localProject = { id: "local-app" };

	it("keeps an empty registered SSH repository remote", () => {
		const [group] = withRegisteredRepositories([], [{ ...remoteProject, name: "app" }], []);
		expect(repositoryRemoteHostId(group, [remoteProject])).toBe("host-a");
	});

	it("keeps a remote repository remote while only local panes are open", () => {
		// hostId는 ssh pane과 원격 세션 에이전트만 채운다 — 원격 저장소에 평범한
		// 로컬 터미널만 떠 있는 순간에도 저장소 정체성은 바뀌지 않아야 한다.
		const [group] = groupSpacesByRepository([
			{ key: "term", projectId: "remote-app", projectName: "work" },
		] satisfies Row[]);

		expect(repositoryRemoteHostId(group, [remoteProject])).toBe("host-a");
	});

	it("reads a local repository as local even when a pane carries a host", () => {
		// 기록이 로컬이면 pane이 무엇을 달고 있든 로컬이다 — 폴백은 등록된
		// 기록이 아예 없는 그룹 전용이다.
		const [group] = groupSpacesByRepository([
			{ key: "ssh", projectId: "local-app", projectName: "app", hostId: "host-z" },
		] satisfies Row[]);

		expect(repositoryRemoteHostId(group, [localProject])).toBeUndefined();
	});

	it("treats an empty sshHostId as no host rather than a remote identity", () => {
		const [group] = groupSpacesByRepository([
			{ key: "term", projectId: "blank-app", projectName: "app" },
		] satisfies Row[]);

		expect(
			repositoryRemoteHostId(group, [{ id: "blank-app", sshHostId: "" }]),
		).toBeUndefined();
	});

	it("falls back to the pane host for groups with no registered project", () => {
		const [group] = groupSpacesByRepository([
			{ key: "ssh", projectName: "work", hostId: "host-b" },
		] satisfies Row[]);

		expect(repositoryRemoteHostId(group, [])).toBe("host-b");
	});
});

describe("groupSpacesByRepositoryAcrossDesktops", () => {
	interface DesktopRow extends Row {
		readonly desktopId: string;
	}
	const desktops = [{ id: "d1" }, { id: "d2" }, { id: "d3" }];

	it("orders repositories by first appearance and nests desktops in desktop order", () => {
		const alphaD1: DesktopRow = {
			key: "alpha-d1",
			desktopId: "d1",
			projectId: "alpha",
			projectName: "Alpha",
		};
		const betaD1: DesktopRow = {
			key: "beta-d1",
			desktopId: "d1",
			projectId: "beta",
			projectName: "Beta",
		};
		const alphaD2a: DesktopRow = {
			key: "alpha-d2-a",
			desktopId: "d2",
			projectId: "alpha",
			projectName: "Alpha",
		};
		const alphaD2b: DesktopRow = {
			key: "alpha-d2-b",
			desktopId: "d2",
			projectId: "alpha",
			projectName: "Alpha",
		};
		const rowsByDesktop = new Map<string, readonly DesktopRow[]>([
			// Desktop order decides the walk, not the map's insertion order.
			["d2", [alphaD2a, alphaD2b]],
			["d1", [alphaD1, betaD1]],
		]);

		const groups = groupSpacesByRepositoryAcrossDesktops(desktops, rowsByDesktop);

		expect(groups.map((group) => group.key)).toEqual([
			'["project","alpha"]',
			'["project","beta"]',
		]);
		const [alpha, beta] = groups;
		expect(alpha.label).toBe("Alpha");
		// Flat rows follow the visual order: desktop by desktop, pane order within.
		expect(alpha.spaces).toEqual([alphaD1, alphaD2a, alphaD2b]);
		expect(
			alpha.desktops.map((bucket) => [
				bucket.desktop.id,
				bucket.spaces.map((row) => row.key),
			]),
		).toEqual([
			["d1", ["alpha-d1"]],
			["d2", ["alpha-d2-a", "alpha-d2-b"]],
		]);
		expect(beta.desktops).toEqual([{ desktop: desktops[0], spaces: [betaD1] }]);
	});

	it("skips desktops without visible rows so an empty desktop never renders a group", () => {
		const groups = groupSpacesByRepositoryAcrossDesktops(
			desktops,
			new Map<string, readonly DesktopRow[]>([
				["d3", [{ key: "k", desktopId: "d3", projectName: "로컬" }]],
			]),
		);

		expect(groups).toHaveLength(1);
		expect(groups[0].desktops.map((bucket) => bucket.desktop.id)).toEqual(["d3"]);
	});

	it("returns no groups when nothing is visible", () => {
		expect(groupSpacesByRepositoryAcrossDesktops(desktops, new Map())).toEqual([]);
	});
});

describe("spaceRepositoryGroupKey", () => {
	it("matches the key groupSpacesByRepository assigns", () => {
		const row: Row = { key: "k", projectName: "work", hostId: "host-a" };
		expect(spaceRepositoryGroupKey(row)).toBe(groupSpacesByRepository([row])[0].key);
	});
});

describe("withRegisteredRepositories", () => {
	const group = (projectId: string, label: string) => ({
		key: JSON.stringify(["project", projectId]),
		label,
		spaces: [] as never[],
		desktops: [] as never[],
	});

	it("appends registered repositories that have no rows, after the ones that do", () => {
		const listed = withRegisteredRepositories(
			[group("p2", "Two")],
			[
				{ id: "p1", name: "One" },
				{ id: "p2", name: "Two" },
				{ id: "p3", name: "Three" },
			],
			[],
		);
		expect(listed.map((entry) => entry.label)).toEqual(["Two", "One", "Three"]);
		expect(listed[1]).toEqual({
			key: JSON.stringify(["project", "p1"]),
			label: "One",
			projectId: "p1",
			spaces: [],
			desktops: [],
		});
	});

	it("leads with pinned repositories in pin order, open or empty", () => {
		const listed = withRegisteredRepositories(
			[group("p1", "One"), group("p2", "Two")],
			[
				{ id: "p1", name: "One" },
				{ id: "p2", name: "Two" },
				{ id: "p3", name: "Three" },
			],
			["p3", "p2", "missing"],
		);
		expect(listed.map((entry) => entry.label)).toEqual(["Three", "Two", "One"]);
	});

	it("keeps location groups without a project where they were", () => {
		const location = {
			key: JSON.stringify(["location", "host-1", "srv"]),
			label: "srv",
			spaces: [] as never[],
			desktops: [] as never[],
		};
		const listed = withRegisteredRepositories(
			[location, group("p1", "One")],
			[{ id: "p1", name: "One" }],
			[],
		);
		expect(listed.map((entry) => entry.label)).toEqual(["srv", "One"]);
	});
});

describe("group project identity", () => {
	it("carries the registered project on a project-keyed group and nothing on a location group", () => {
		const [project, location] = groupSpacesByRepository([
			{ key: "a", projectId: "alpha", projectName: "Alpha" },
			{ key: "b", projectName: "로컬" },
		]);
		expect(project.projectId).toBe("alpha");
		expect(location.projectId).toBeUndefined();
	});

	it("gives a registered repository with no rows its project too", () => {
		const [empty] = withRegisteredRepositories([], [{ id: "p1", name: "One" }], []);
		expect(empty.projectId).toBe("p1");
	});
});
