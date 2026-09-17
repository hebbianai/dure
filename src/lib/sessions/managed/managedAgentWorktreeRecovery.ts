import { normalizeSlashPath, pathBasename } from "@/lib/files/paths";
import * as gitIpc from "@/lib/ipc/git";
import { worktreeDirName } from "@/lib/scm/worktrees/worktreePlan";
import type {
	TerminalAttachWorktreeRecovery,
	TerminalAttachWorktreeStatus,
} from "@/lib/terminal/terminalAttachRecovery";
import type { Agent, Project } from "@/types";

export type ManagedAgentWorktreeRecoveryDeps = Pick<
	typeof gitIpc,
	"listDir" | "locateGitCheckoutPaths" | "provisionWorktree"
>;

export interface ManagedAgentWorktreeRecoveryPlan {
	readonly repo: string;
	readonly branch: string;
	readonly worktreePath: string;
	readonly worktreeRoot: string;
	readonly inspectionBase: string;
	readonly inspectionSegments: readonly string[];
}

function normalizedAbsolutePath(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const path = normalizeSlashPath(trimmed);
	if (
		path.includes("\0") ||
		(!path.startsWith("/") && !/^[A-Za-z]:\//u.test(path)) ||
		path.split("/").some((segment) => segment === "." || segment === "..")
	) {
		return undefined;
	}
	return path;
}

function pathKey(path: string): string {
	return /^[A-Za-z]:\//u.test(path)
		? `${path[0]?.toUpperCase()}${path.slice(1)}`
		: path;
}

function sameAbsolutePath(left: string, right: string): boolean {
	const normalizedLeft = normalizedAbsolutePath(left);
	const normalizedRight = normalizedAbsolutePath(right);
	return Boolean(
		normalizedLeft &&
			normalizedRight &&
			pathKey(normalizedLeft) === pathKey(normalizedRight),
	);
}

function parentPath(path: string): string | undefined {
	const separator = path.lastIndexOf("/");
	if (separator < 0) return undefined;
	if (separator === 0) return "/";
	if (separator === 2 && /^[A-Za-z]:\//u.test(path)) return path.slice(0, 3);
	return path.slice(0, separator);
}

function appendPath(base: string, segments: readonly string[]): string {
	return `${base.replace(/\/+$/u, "")}/${segments.join("/")}`;
}

/** Reconstruct the only backend provision plan that can produce the Agent's
 * recorded path. Arbitrary external paths and renamed branch directories are
 * deliberately not guessed. */
export function planManagedAgentWorktreeRecovery(
	agent: Agent,
	project: Project | undefined,
): ManagedAgentWorktreeRecoveryPlan | undefined {
	if (project?.kind !== "local" || !project.isRepo) return undefined;
	const branch = agent.branch.trim();
	const directory = worktreeDirName(branch);
	const repo = normalizedAbsolutePath(project.path);
	const target = normalizedAbsolutePath(agent.worktreePath);
	if (!branch || !directory || !repo || !target) {
		return undefined;
	}
	if (
		sameAbsolutePath(repo, target) ||
		pathKey(pathBasename(target, "")) !== pathKey(directory)
	) {
		return undefined;
	}

	const targetParent = parentPath(target);
	if (!targetParent) return undefined;
	let worktreeRoot: string;
	let inspectionBase: string;
	let inspectionSegments: readonly string[];
	const repoPrefix = `${pathKey(repo).replace(/\/+$/u, "")}/`;
	if (pathKey(targetParent).startsWith(repoPrefix)) {
		const rootSegments = targetParent.slice(repoPrefix.length).split("/");
		if (rootSegments.length === 0 || rootSegments.some((segment) => !segment)) {
			return undefined;
		}
		worktreeRoot = rootSegments.join("/");
		inspectionBase = project.path;
		inspectionSegments = [...rootSegments, directory];
	} else {
		const repoParent = parentPath(repo);
		if (!repoParent || !sameAbsolutePath(targetParent, repoParent)) {
			return undefined;
		}
		worktreeRoot = "..";
		inspectionBase = repoParent;
		inspectionSegments = [directory];
	}

	return {
		repo: project.path,
		branch,
		worktreePath: agent.worktreePath,
		worktreeRoot,
		inspectionBase,
		inspectionSegments,
	};
}

function expectedCanonicalWorktreePath(
	plan: ManagedAgentWorktreeRecoveryPlan,
	canonicalRepo: string,
): string | undefined {
	const repo = normalizedAbsolutePath(canonicalRepo);
	if (!repo) return undefined;
	const directory = worktreeDirName(plan.branch);
	const base = plan.worktreeRoot === ".." ? parentPath(repo) : repo;
	return base
		? appendPath(
				base,
				plan.worktreeRoot === ".."
					? [directory]
					: [plan.worktreeRoot, directory],
			)
		: undefined;
}

export async function inspectManagedAgentWorktree(
	plan: ManagedAgentWorktreeRecoveryPlan,
	deps: ManagedAgentWorktreeRecoveryDeps = gitIpc,
): Promise<TerminalAttachWorktreeStatus> {
	let current = plan.inspectionBase;
	try {
		for (const segment of plan.inspectionSegments) {
			const entries = await deps.listDir(current, true, false);
			const entry = entries.find((candidate) => candidate.name === segment);
			if (!entry) return "missing";
			if (!entry.isDir) return "occupied";
			current = entry.path;
		}
		const [repository, worktree] = await deps.locateGitCheckoutPaths([
			plan.repo,
			plan.worktreePath,
		]);
		if ((repository && "absentPath" in repository) || (worktree && "absentPath" in worktree)) {
			return "occupied";
		}
		const expected = repository
			? expectedCanonicalWorktreePath(plan, repository.canonicalPath)
			: undefined;
		return repository &&
			worktree &&
			expected &&
			sameAbsolutePath(worktree.canonicalPath, expected) &&
			sameAbsolutePath(worktree.gitCommonDir, repository.gitCommonDir)
			? "present"
			: "occupied";
	} catch {
		return "unavailable";
	}
}

export async function recreateManagedAgentWorktree(
	plan: ManagedAgentWorktreeRecoveryPlan,
	deps: ManagedAgentWorktreeRecoveryDeps = gitIpc,
): Promise<void> {
	const observed = await inspectManagedAgentWorktree(plan, deps);
	if (observed === "present") return;
	if (observed !== "missing") {
		throw new Error(`managed_agent_worktree_${observed}: ${plan.worktreePath}`);
	}

	let receipt: Awaited<ReturnType<typeof deps.provisionWorktree>>;
	try {
		receipt = await deps.provisionWorktree({
			repo: plan.repo,
			branch: plan.branch,
			worktreePath: plan.worktreePath,
			action: "checkout-existing-branch",
			worktreeRoot: plan.worktreeRoot,
		});
	} catch (cause) {
		// A concurrent identical recovery is success, never a collision to mask.
		if ((await inspectManagedAgentWorktree(plan, deps)) === "present") return;
		throw cause;
	}
	if (
		!sameAbsolutePath(receipt.path, plan.worktreePath) ||
		receipt.branch !== plan.branch
	) {
		throw new Error(
			`managed_agent_worktree_identity_mismatch: expected ${plan.worktreePath} (${plan.branch}), got ${receipt.path} (${receipt.branch})`,
		);
	}
}

export function managedAgentWorktreeRecovery(
	agent: Agent,
	project: Project | undefined,
	deps: ManagedAgentWorktreeRecoveryDeps = gitIpc,
): TerminalAttachWorktreeRecovery | undefined {
	const plan = planManagedAgentWorktreeRecovery(agent, project);
	if (!plan) return undefined;
	return {
		path: plan.worktreePath,
		branch: plan.branch,
		inspect: () => inspectManagedAgentWorktree(plan, deps),
		recreate: () => recreateManagedAgentWorktree(plan, deps),
	};
}
