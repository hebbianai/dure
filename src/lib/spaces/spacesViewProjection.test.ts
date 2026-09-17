import { describe, expect, it } from "vitest";
import {
	EMPTY_SPACES_FILTERS,
	type SpacesFilters,
} from "@/lib/spaces/spacesViewOptions";
import {
	groupSpacesRows,
	orderSpacesRows,
	projectSpacesRows,
	spacesFacetBucket,
	spacesFieldsPresent,
	spacesFilterChoices,
	spacesRowFacets,
	visibleSpacesRowMetadata,
} from "@/lib/spaces/spacesViewProjection";

describe("orderSpacesRows", () => {
	const rows = [
		{ key: "older", activityAt: 10, displayState: "waiting" as const },
		{ key: "unknown", displayState: undefined },
		{ key: "newer-a", activityAt: 20, displayState: "blocked" as const },
		{ key: "newer-b", activityAt: 20, displayState: "blocked" as const },
	];

	it("returns the unchanged Dockview order until dynamic ordering is selected", () => {
		expect(orderSpacesRows(rows, "stable")).toBe(rows);
	});

	it("orders newest activity first, unknown last, and keeps equal rows stable", () => {
		expect(orderSpacesRows(rows, "updated").map((row) => row.key)).toEqual([
			"newer-a",
			"newer-b",
			"older",
			"unknown",
		]);
		expect(rows.map((row) => row.key)).toEqual([
			"older",
			"unknown",
			"newer-a",
			"newer-b",
		]);
	});

	it("orders attention and error before active, idle, exited, and unknown rows", () => {
		const byStatus = [
			{ key: "unknown" },
			{ key: "exited", displayState: "exited" as const },
			{ key: "idle", displayState: "waiting" as const },
			{ key: "connecting", displayState: "connecting" as const },
			{ key: "working", displayState: "working" as const },
			{ key: "input", displayState: "input" as const },
			{ key: "blocked", displayState: "blocked" as const },
			{ key: "error", displayState: "error" as const },
		];
		expect(orderSpacesRows(byStatus, "status").map((row) => row.key)).toEqual([
			"error",
			"blocked",
			"input",
			"working",
			"connecting",
			"idle",
			"exited",
			"unknown",
		]);
	});
});

describe("Spaces facet projection", () => {
	const rows = [
		{
			key: "local-codex",
			activityAt: 10,
			displayState: "working" as const,
			projectId: "repo-1",
			projectName: "Dure",
			cwd: "/repo/.worktrees/a",
			desktopId: "space-1",
			desktopName: "Build",
			kind: "agent" as const,
			hostLabel: "Local",
			provider: "codex" as const,
			branch: "agent/a",
		},
		{
			key: "remote-claude",
			activityAt: 20,
			displayState: "blocked" as const,
			projectId: "repo-2",
			projectName: "API",
			cwd: "/srv/api",
			desktopId: "space-2",
			desktopName: "Review",
			kind: "agent" as const,
			hostId: "host-1",
			hostLabel: "builder",
			provider: "claude" as const,
			branch: "agent/review",
		},
		{
			key: "remote-shell",
			projectId: "repo-2",
			projectName: "API",
			cwd: "/srv/api",
			desktopId: "space-2",
			desktopName: "Review",
			kind: "ssh" as const,
			hostId: "host-1",
			hostLabel: "builder",
			provider: null,
		},
	];

	it("ORs values within a facet and ANDs the active facets after search", () => {
		const filters: SpacesFilters = {
			...EMPTY_SPACES_FILTERS,
			status: ["working", "blocked"],
			environment: ["ssh"],
			source: ["provider:claude", "shell"],
		};
		expect(
			projectSpacesRows(rows, {
				filters,
				orderBy: "updated",
				matchesSearch: (row) => row.projectName === "API",
			}).map((row) => row.key),
		).toEqual(["remote-claude"]);
	});

	it("derives menu choices from canonical row facets and retains stale selections", () => {
		const choices = spacesFilterChoices(rows, {
			...EMPTY_SPACES_FILTERS,
			location: ['["location","gone","/old"]'],
		});
		expect(choices.status).toEqual(["blocked", "working", "unknown"]);
		expect(choices.environment).toEqual(["local", "ssh"]);
		expect(choices.source).toEqual([
			"provider:codex",
			"provider:claude",
			"ssh",
		]);
		expect(choices.repository.map((choice) => choice.label)).toEqual([
			"Dure",
			"API",
		]);
		expect(choices.location.slice(0, 2).map((choice) => choice.label)).toEqual([
			"/repo/.worktrees/a",
			"builder · /srv/api",
		]);
		expect(choices.location[choices.location.length - 1]).toEqual({
			value: '["location","gone","/old"]',
		});
	});

	it("names the fields the listed rows can show at all", () => {
		// A local terminal at its repository root: a path, nothing else.
		expect(
			spacesFieldsPresent([
				{ kind: "term", cwd: "/repo", hostLabel: "Local", detail: "/repo" },
			]),
		).toEqual(new Set(["environment", "details"]));
		// A remote agent with activity and a branch lights everything.
		expect(spacesFieldsPresent([{ ...rows[1], detail: "Fix" }])).toEqual(
			new Set(["environment", "updated", "branch", "machine", "details", "gitStatus"]),
		);
		expect(spacesFieldsPresent([])).toEqual(new Set());
	});

	it("selects metadata independently and leaves out what the headings over the row state", () => {
		const fields = ["environment", "branch", "machine"] as const;
		// The flat pinned list states nothing, so the row says it all — the
		// space included, which is not a selectable field. A local row has no
		// machine to name: "Local" is the environment's word, said once.
		expect(
			visibleSpacesRowMetadata(rows[0], fields, { spaceHeading: false, showSpaces: true }),
		).toEqual([
			{ field: "environment", value: "local" },
			{ field: "space", value: "Build" },
			{ field: "branch", value: "agent/a" },
		]);
		expect(
			visibleSpacesRowMetadata(rows[1], fields, { spaceHeading: false, showSpaces: true }),
		).toEqual([
			{ field: "environment", value: "ssh" },
			{ field: "space", value: "Review" },
			{ field: "branch", value: "agent/review" },
			{ field: "machine", value: "builder" },
		]);
		// Under a space heading — in the repository tree as much as the space
		// tree — the row does not repeat the space.
		expect(
			visibleSpacesRowMetadata(rows[1], fields, {
				groupBy: "repository",
				spaceHeading: true,
				showSpaces: true,
			}),
		).toEqual([
			{ field: "environment", value: "ssh" },
			{ field: "branch", value: "agent/review" },
			{ field: "machine", value: "builder" },
		]);
		// A folded repository's lone focused row has no space heading over it.
		expect(
			visibleSpacesRowMetadata(rows[1], [], {
				groupBy: "repository",
				spaceHeading: false,
				showSpaces: true,
			}),
		).toEqual([{ field: "space", value: "Review" }]);
		// Show › Space off hides the space even where no heading states it.
		expect(
			visibleSpacesRowMetadata(rows[1], [], {
				groupBy: "repository",
				spaceHeading: false,
				showSpaces: false,
			}),
		).toEqual([]);
		// The Local/SSH band states the environment; the machine still adds
		// the host under "SSH".
		expect(
			visibleSpacesRowMetadata(rows[1], fields, {
				groupBy: "environment",
				spaceHeading: true,
				showSpaces: true,
			}),
		).toEqual([
			{ field: "branch", value: "agent/review" },
			{ field: "machine", value: "builder" },
		]);
		// A location heading is "host · path": machine and environment both.
		expect(
			visibleSpacesRowMetadata(rows[1], fields, {
				groupBy: "location",
				spaceHeading: true,
				showSpaces: true,
			}),
		).toEqual([{ field: "branch", value: "agent/review" }]);
	});
});

describe("groupSpacesRows", () => {
	it("represents absent row facets explicitly instead of inventing local facts", () => {
		expect(spacesRowFacets({})).toMatchObject({
			status: "unknown",
			environment: "unknown",
			repository: { value: "unknown" },
			location: { value: "unknown" },
			space: { value: "unknown" },
			machine: { value: "unknown" },
		});
		expect(spacesRowFacets({ kind: "ssh", cwd: "/srv/repo" })).toMatchObject(
			{
				location: { value: "unknown" },
				machine: { value: "unknown" },
			},
		);
	});

	it("groups exact host-scoped locations in first-pane order", () => {
		const rows = [
			{
				key: "local-a",
				kind: "agent" as const,
				cwd: "/repo/.worktrees/a",
				hostLabel: "Local",
			},
			{
				key: "remote-a",
				kind: "agent" as const,
				cwd: "/repo/.worktrees/a",
				hostId: "builder-id",
				hostLabel: "builder",
			},
			{
				key: "local-b",
				kind: "term" as const,
				cwd: "/repo/.worktrees/a",
				hostLabel: "Local",
			},
			{ key: "unknown", kind: "ssh" as const },
		];

		expect(
			groupSpacesRows(rows, "location", 0).map((group) => ({
				bucket: group.bucket,
				rows: group.spaces.map((row) => row.key),
			})),
		).toEqual([
			{
				bucket: {
					axis: "location",
					value: '["location",null,"/repo/.worktrees/a"]',
					label: "/repo/.worktrees/a",
				},
				rows: ["local-a", "local-b"],
			},
			{
				bucket: {
					axis: "location",
					value: '["location","builder-id","/repo/.worktrees/a"]',
					label: "builder · /repo/.worktrees/a",
				},
				rows: ["remote-a"],
			},
			{
				bucket: { axis: "location", value: "unknown" },
				rows: ["unknown"],
			},
		]);
	});

	it("groups environments as Local, SSH, then Unknown with stable rows", () => {
		const rows = [
			{ key: "ssh-a", kind: "ssh" as const },
			{ key: "local-a", kind: "agent" as const },
			{ key: "unknown" },
			{ key: "local-b", kind: "term" as const },
		];

		expect(
			groupSpacesRows(rows, "environment", 0).map((group) => ({
				bucket: group.bucket,
				rows: group.spaces.map((row) => row.key),
			})),
		).toEqual([
			{
				bucket: { axis: "environment", value: "local" },
				rows: ["local-a", "local-b"],
			},
			{
				bucket: { axis: "environment", value: "ssh" },
				rows: ["ssh-a"],
			},
			{
				bucket: { axis: "environment", value: "unknown" },
				rows: ["unknown"],
			},
		]);
	});

	it("classifies exact local-day boundaries without duration arithmetic", () => {
		const today = new Date(2026, 8, 4);
		today.setHours(0, 0, 0, 0);
		const yesterday = new Date(today);
		yesterday.setDate(yesterday.getDate() - 1);
		const sixDaysAgo = new Date(today);
		sixDaysAgo.setDate(sixDaysAgo.getDate() - 6);
		const bucket = (updatedAt?: number) =>
			spacesFacetBucket(
				spacesRowFacets({ activityAt: updatedAt }),
				"updated",
				today.getTime(),
			).value;

		expect(bucket(today.getTime())).toBe("today");
		expect(bucket(today.getTime() - 1)).toBe("yesterday");
		expect(bucket(yesterday.getTime())).toBe("yesterday");
		expect(bucket(yesterday.getTime() - 1)).toBe("lastSevenDays");
		expect(bucket(sixDaysAgo.getTime())).toBe("lastSevenDays");
		expect(bucket(sixDaysAgo.getTime() - 1)).toBe("older");
		expect(bucket()).toBe("unknown");
	});

	it("uses one local calendar snapshot for updated buckets", () => {
		const at = (day: number, hour = 12) =>
			new Date(2026, 8, day, hour, 0, 0, 0).getTime();
		const groups = groupSpacesRows(
			[
				{ key: "future", activityAt: at(5) },
				{ key: "today", activityAt: at(4, 0) },
				{ key: "yesterday", activityAt: at(3, 23) },
				{ key: "six-days", activityAt: new Date(2026, 7, 29, 12).getTime() },
				{ key: "older", activityAt: new Date(2026, 7, 28, 23).getTime() },
				{ key: "missing" },
				{ key: "invalid", activityAt: Number.NaN },
			],
			"updated",
			at(4),
		);

		expect(
			groups.map((group) => ({
				bucket: group.bucket.value,
				rows: group.spaces.map((row) => row.key),
			})),
		).toEqual([
			{ bucket: "today", rows: ["future", "today"] },
			{ bucket: "yesterday", rows: ["yesterday"] },
			{ bucket: "lastSevenDays", rows: ["six-days"] },
			{ bucket: "older", rows: ["older"] },
			{ bucket: "unknown", rows: ["missing", "invalid"] },
		]);
	});

	it("keeps status buckets in priority order with stable rows and attention", () => {
		const groups = groupSpacesRows(
			[
				{ key: "waiting", displayState: "waiting" as const },
				{ key: "blocked-a", displayState: "blocked" as const },
				{ key: "unknown" },
				{ key: "error", displayState: "error" as const },
				{ key: "blocked-b", displayState: "blocked" as const },
				{ key: "input", displayState: "input" as const },
				{ key: "working", displayState: "working" as const },
				{ key: "connecting", displayState: "connecting" as const },
				{ key: "exited", displayState: "exited" as const },
			],
			"status",
			0,
		);

		expect(
			groups.map((group) => ({
				bucket: group.bucket.value,
				rows: group.spaces.map((row) => row.key),
				attention: group.attentionCount,
			})),
		).toEqual([
			{ bucket: "error", rows: ["error"], attention: 1 },
			{
				bucket: "blocked",
				rows: ["blocked-a", "blocked-b"],
				attention: 2,
			},
			{ bucket: "input", rows: ["input"], attention: 1 },
			{ bucket: "working", rows: ["working"], attention: 0 },
			{ bucket: "connecting", rows: ["connecting"], attention: 0 },
			{ bucket: "waiting", rows: ["waiting"], attention: 0 },
			{ bucket: "exited", rows: ["exited"], attention: 0 },
			{ bucket: "unknown", rows: ["unknown"], attention: 0 },
		]);
	});

	it("keeps a visible bucket's attention count independent of search", () => {
		const rows = [
			{ key: "visible", activityAt: 10, displayState: "working" as const },
			{ key: "filtered", activityAt: 10, displayState: "blocked" as const },
		];
		const [group] = groupSpacesRows(
			rows,
			"updated",
			10,
			(row) => row.key === "visible",
		);

		expect(group?.spaces.map((row) => row.key)).toEqual(["visible"]);
		expect(group?.attentionCount).toBe(1);
	});
});
