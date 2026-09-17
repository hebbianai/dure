import { describe, expect, it } from "vitest";
import {
	type QuickAddSpaceRow,
	quickAddAgentName,
	repositoryQuickAddTarget,
} from "@/lib/spaces/repositoryQuickAdd";
import type { Project } from "@/types";

function row(overrides: Partial<QuickAddSpaceRow> = {}): QuickAddSpaceRow {
	return { projectName: "Dure", ...overrides };
}

function group(spaces: readonly QuickAddSpaceRow[]) {
	return { key: "k", label: "Dure", spaces };
}

const LOCAL: Project = {
	id: "p1",
	name: "Dure",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const REMOTE: Project = {
	id: "p1",
	name: "Dure",
	path: "/srv/repo",
	kind: "ssh",
	sshHostId: "h1",
	isRepo: true,
};

describe("repositoryQuickAddTarget", () => {
	it("takes the folder from the registered project", () => {
		const target = repositoryQuickAddTarget(
			group([row({ projectId: "p1", cwd: "/repo/.worktrees/feature" })]),
			[LOCAL],
		);
		expect(target).toEqual({
			label: "Dure",
			path: "/repo",
			projectId: "p1",
		});
	});

	/** A local terminal open on a remote repository must not make the next
	 *  session local — the project record decides the host. */
	it("keeps a remote repository remote while only a local pane is open", () => {
		const target = repositoryQuickAddTarget(
			group([row({ projectId: "p1", cwd: "/tmp/local-scratch" })]),
			[REMOTE],
		);
		expect(target).toEqual({
			label: "Dure",
			path: "/srv/repo",
			projectId: "p1",
			hostId: "h1",
		});
	});

	it("falls back to the first pane's folder for an unregistered location", () => {
		const target = repositoryQuickAddTarget(
			group([row(), row({ cwd: "/elsewhere", hostId: "h2" })]),
			[LOCAL],
		);
		expect(target).toEqual({
			label: "Dure",
			path: "/elsewhere",
			hostId: "h2",
		});
	});

	it("returns null when nothing in the group knows a folder", () => {
		expect(repositoryQuickAddTarget(group([row()]), [])).toBeNull();
	});
});

describe("quickAddAgentName", () => {
	it("names the next agent after the project's current count", () => {
		expect(quickAddAgentName("claude", ["claude-1", "codex-1"])).toBe(
			"claude-3",
		);
	});

	/** Removals leave gaps: the count alone can land on a name still in use,
	 *  and the canonical run would then answer with the earlier agent. */
	it("steps past a name a removal left behind", () => {
		expect(quickAddAgentName("claude", ["claude-3", "claude-4"])).toBe(
			"claude-5",
		);
	});
});

describe("repositoryQuickAddTarget for a repository nothing is open in", () => {
	it("starts from the registered project the group stands for", () => {
		expect(
			repositoryQuickAddTarget(
				{ key: '["project","p1"]', label: "Repo One", projectId: "p1", spaces: [] },
				[{ id: "p1", name: "Repo One", path: "/repo-one", kind: "local", isRepo: true }],
			),
		).toEqual({ label: "Repo One", path: "/repo-one", projectId: "p1" });
	});
});
