import { afterEach, describe, expect, it, vi } from "vitest";

const createLocalProjectMock = vi.fn();

vi.mock("@/lib/spaces/projectAdd", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/spaces/projectAdd")>()),
	createLocalProject: (path: string) => createLocalProjectMock(path),
	projectAtPath: (
		projects: Array<{ kind: string; path: string; sshHostId?: string }>,
		path: string,
		sshHostId?: string,
	) =>
		projects.find(
			(project) =>
				project.path.replace(/\/+$/, "") === path.replace(/\/+$/, "") &&
				(sshHostId
					? project.kind === "ssh" && project.sshHostId === sshHostId
					: project.kind === "local"),
		),
}));

import { useStore } from "@/store";

const originalProjects = useStore.getState().projects;

afterEach(() => {
	useStore.setState({ projects: originalProjects });
	vi.clearAllMocks();
});

describe("canonical local Project registration", () => {
	it("preserves repository identity when a later Git inspection is unavailable", async () => {
		const primary = {
			id: "existing",
			name: "My chosen name",
			path: "/repo",
			kind: "local" as const,
			isRepo: true,
		};
		useStore.setState({ projects: [primary] });
		createLocalProjectMock.mockResolvedValue({
			...primary,
			id: "new",
			name: "repo",
			isRepo: false,
		});
		expect(
			await useStore.getState().addLocalProject(primary.path),
		).toStrictEqual(primary);
		expect(useStore.getState().projects).toEqual([primary]);
	});

	it("reuses an existing primary Project after a linked worktree resolves to it", async () => {
		const primary = {
			id: "project-hebbian",
			name: "HebbianIDE",
			path: "/repo/HebbianIDE",
			kind: "local" as const,
			isRepo: true,
		};
		useStore.setState({ projects: [primary] });
		createLocalProjectMock.mockResolvedValue({
			...primary,
			id: "project-duplicate",
		});

		const project = await useStore
			.getState()
			.addLocalProject("/repo/HebbianIDE/.worktrees/patric");

		expect(project).toStrictEqual(primary);
		expect(useStore.getState().projects).toEqual([primary]);
	});
});
