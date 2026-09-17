import type { Project } from "@/types";

type PresentationProjectFailure = (code: string, message: string) => never;

function normalizedRoot(path: string): string {
	return path.replace(/\/+$/u, "") || path;
}

function isTargetProject(
	project: Project,
	hostId: string | undefined,
): boolean {
	return hostId === undefined
		? project.kind === "local"
		: project.kind === "ssh" && project.sshHostId === hostId;
}

/** Resolve a backend-selected project only through its canonical root. The
 * backend project ID remains opaque to the client and is never reinterpreted
 * as a local registry ID or display name. */
export async function resolveRunPresentationProject(
	projects: readonly Project[],
	projectRoot: string | undefined,
	hostId: string | undefined,
	ensureProject: (path: string, hostId?: string) => Promise<Project>,
	fail: PresentationProjectFailure,
): Promise<Project> {
	if (!projectRoot) {
		return fail(
			"client_project_root_unavailable",
			"backend project root is unavailable for client presentation",
		);
	}
	const root = normalizedRoot(projectRoot);
	const matches = projects.filter(
		(project) =>
			isTargetProject(project, hostId) && normalizedRoot(project.path) === root,
	);
	if (matches.length > 1) {
		return fail(
			"client_project_ambiguous",
			"backend project root maps to multiple Dure client projects",
		);
	}
	return ensureProject(projectRoot, hostId);
}
