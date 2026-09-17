import { fnv1a32Hex } from "@/lib/platform/hash";
import type { Project } from "@/types";

export interface PluginWorkspaceFocus {
	cwd: string;
	source: "local" | "ssh";
	hostId?: string;
}

export interface PluginWorkspaceContext {
	root: string;
	projectId: string | null;
	scopeKey: string | null;
	watchKey: string;
	source: "local" | "ssh";
}

function normalizePath(path: string): string {
	return path.replace(/\/+$/, "") || "/";
}

/** Plugin workspace identity is shared by settings and contributed views.
 * Registered projects execute from their declared root, never a terminal's
 * mutable current directory. */
export function pluginWorkspaceContext(
	focus: PluginWorkspaceFocus | null,
	projects: Project[],
): PluginWorkspaceContext | null {
	if (!focus) return null;
	const root = normalizePath(focus.cwd);
	const project = projects
		.filter((candidate) =>
			focus.source === "ssh"
				? candidate.kind === "ssh" && candidate.sshHostId === focus.hostId
				: candidate.kind === "local",
		)
		.filter((candidate) => {
			const projectRoot = normalizePath(candidate.path);
			return root === projectRoot || root.startsWith(`${projectRoot}/`);
		})
		.sort(
			(left, right) =>
				normalizePath(right.path).length - normalizePath(left.path).length,
		)[0];
	const workspaceRoot = project ? normalizePath(project.path) : root;
	const scopeKey = project
		? `${project.kind}:${project.sshHostId ?? "local"}:${project.id}`
		: null;
	return {
		root: workspaceRoot,
		projectId: project?.id ?? null,
		scopeKey,
		watchKey:
			(project
				? `${project.kind}:${project.sshHostId ?? "local"}:${project.id}`
				: null) ??
			`${focus.source}:${focus.hostId ?? "local"}:unregistered:${fnv1a32Hex(root)}`,
		source: focus.source,
	};
}
