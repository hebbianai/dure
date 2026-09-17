import { describe, expect, it } from "vitest";
import { pluginWorkspaceContext } from "@/lib/plugins/pluginWorkspace";
import type { Project } from "@/types";

const projects: Project[] = [
	{
		id: "repo",
		name: "Repo",
		path: "/work/repo",
		kind: "local",
		isRepo: true,
	},
	{
		id: "nested",
		name: "Nested",
		path: "/work/repo/packages/app",
		kind: "local",
		isRepo: true,
	},
];

describe("pluginWorkspaceContext", () => {
	it("uses the longest owning project root instead of a terminal subdirectory", () => {
		expect(
			pluginWorkspaceContext(
				{ cwd: "/work/repo/packages/app/src/", source: "local" },
				projects,
			),
		).toEqual({
			root: "/work/repo/packages/app",
			projectId: "nested",
			scopeKey: "local:local:nested",
			watchKey: "local:local:nested",
			source: "local",
		});
	});

	it("does not match an SSH project from a different host", () => {
		const result = pluginWorkspaceContext(
			{ cwd: "/srv/repo", source: "ssh", hostId: "host-b" },
			[
				{
					id: "remote",
					name: "Remote",
					path: "/srv/repo",
					kind: "ssh",
					sshHostId: "host-a",
					isRepo: true,
				},
			],
		);
		expect(result?.scopeKey).toBeNull();
		expect(result?.watchKey).toMatch(/^ssh:host-b:unregistered:/);
	});
});
