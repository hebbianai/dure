import { describe, expect, it, vi } from "vitest";
import { resolveRunPresentationProject } from "@/lib/agents/runPresentationProject";
import type { Project } from "@/types";

const project: Project = {
	id: "client-project",
	name: "HebbianIDE",
	path: "/workspace/HebbianIDE",
	kind: "local",
	isRepo: true,
};

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

describe("Run presentation project resolution", () => {
	it("maps an opaque backend project ID through the canonical root", async () => {
		const ensureProject = vi.fn(async () => project);

		await expect(
			resolveRunPresentationProject(
				[project],
				`${project.path}/`,
				undefined,
				ensureProject,
				fail,
			),
		).resolves.toBe(project);
		expect(ensureProject).toHaveBeenCalledWith(`${project.path}/`, undefined);
	});

	it("fails typed before mutation when one root has duplicate projections", async () => {
		const ensureProject = vi.fn(async () => project);
		const duplicate = { ...project, id: "client-project-copy" };

		await expect(
			resolveRunPresentationProject(
				[project, duplicate],
				project.path,
				undefined,
				ensureProject,
				fail,
			),
		).rejects.toMatchObject({ code: "client_project_ambiguous" });
		expect(ensureProject).not.toHaveBeenCalled();
	});
});
