import { describe, expect, it } from "vitest";
import { selectManagedLocations } from "@/lib/spaces/locationManagement";

const projects = [
	{
		id: "local-a",
		name: "Hebbian",
		path: "/work/hebbian",
		kind: "local" as const,
		isRepo: true,
	},
	{
		id: "remote-b",
		name: "runtime",
		path: "/srv/runtime",
		kind: "ssh" as const,
		sshHostId: "host-b",
		isRepo: true,
	},
	{
		id: "local-c",
		name: "docs",
		path: "/work/docs",
		kind: "local" as const,
		isRepo: false,
	},
];

describe("selectManagedLocations", () => {
	it("puts pinned locations first while preserving order within each visual block", () => {
		const selected = selectManagedLocations({
			projects,
			pinnedProjectIds: ["local-c", "remote-b"],
			sshHosts: [{ id: "host-b", name: "pixel" }],
		});

		expect(selected.map(({ project }) => project.id)).toEqual([
			"remote-b",
			"local-c",
			"local-a",
		]);
	});

	it("searches location name, path, and resolved SSH host name", () => {
		const common = {
			projects,
			pinnedProjectIds: [],
			sshHosts: [{ id: "host-b", name: "pixel" }],
		};

		expect(selectManagedLocations({ ...common, query: "HEBB" })).toHaveLength(
			1,
		);
		expect(selectManagedLocations({ ...common, query: "/srv" })).toHaveLength(
			1,
		);
		expect(selectManagedLocations({ ...common, query: "PIXEL" })).toMatchObject(
			[{ project: { id: "remote-b" }, hostName: "pixel" }],
		);
	});

	it("falls back to the SSH host id when a saved host is no longer registered", () => {
		expect(
			selectManagedLocations({
				projects: [projects[1]],
				pinnedProjectIds: [],
				sshHosts: [],
			}),
		).toMatchObject([{ hostName: "host-b" }]);
	});
});
