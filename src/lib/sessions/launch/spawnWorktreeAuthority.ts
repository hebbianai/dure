import type { ProvisionedAgentWorktree } from "@/lib/agents/agentWorktreeProvision";
import {
	createWorktree,
	listDir,
	provisionWorktree,
	resolveExistingWorktree,
	type ResolvedExistingWorktreeHandle,
	type SpawnReceipt,
	worktreeCommand,
} from "@/lib/ipc";
import {
	SagaStepError,
	type SagaRequest,
} from "@/lib/sessions/launch/spawnSagaRequest";
import type { Project } from "@/types";

export function artifactDispositionFromReceipt(
	receipt: SpawnReceipt,
	stepName: string,
	kind: string,
): "created" | "reused" | undefined {
	const entry = receipt.steps.find((step) => step.step === stepName);
	const found = entry?.artifacts?.find((candidate) => candidate.kind === kind);
	return found?.disposition === "created" || found?.disposition === "reused"
		? found.disposition
		: found?.created_by_request === true
			? "created"
			: found?.created_by_request === false
				? "reused"
				: undefined;
}

export function worktreeArtifactFromReceipt(
	receipt: SpawnReceipt,
): ProvisionedAgentWorktree | undefined {
	const entry = receipt.steps.find((step) => step.step === "worktree");
	const found = entry?.artifacts?.find(
		(candidate) => candidate.kind === "worktree",
	);
	return typeof found?.id === "string" && typeof found.branch === "string"
		? { path: found.id, branch: found.branch }
		: undefined;
}

export function existingHandleFromReceipt(
	receipt: SpawnReceipt,
): ResolvedExistingWorktreeHandle | undefined {
	const detail = receipt.steps.find((step) => step.step === "worktree")?.detail;
	if (!detail || typeof detail !== "object") return undefined;
	const handle = (detail as Record<string, unknown>).handle;
	if (!handle || typeof handle !== "object") return undefined;
	const value = handle as Record<string, unknown>;
	const reference = value.reference;
	if (!reference || typeof reference !== "object") return undefined;
	const ref = reference as Record<string, unknown>;
	return value.disposition === "reused" &&
		typeof value.claimId === "string" &&
		typeof value.receiptId === "string" &&
		typeof ref.canonicalPath === "string" &&
		typeof ref.gitCommonDir === "string" &&
		typeof ref.gitDir === "string" &&
		typeof ref.branch === "string" &&
		typeof ref.head === "string"
		? {
				disposition: "reused",
				claimId: value.claimId,
				receiptId: value.receiptId,
				reference: {
					canonicalPath: ref.canonicalPath,
					gitCommonDir: ref.gitCommonDir,
					gitDir: ref.gitDir,
					branch: ref.branch,
					head: ref.head,
				},
			}
		: undefined;
}

export async function requireExistingWorktreeHandle(
	request: SagaRequest,
	project: Project,
): Promise<ResolvedExistingWorktreeHandle> {
	const reference = request.existingWorktreeRef;
	if (!reference) {
		throw new SagaStepError(
			"worktree",
			"existing_worktree_ref_missing",
			"existing worktree resolution requires an exact ref",
		);
	}
	const resolution = await resolveExistingWorktree(
		project.path,
		reference,
		request.receiptId,
	);
	if (resolution.state === "refused") {
		throw new SagaStepError(
			"worktree",
			resolution.code,
			`${resolution.message} ${resolution.recovery}`,
		);
	}
	const handle = resolution.handle;
	if (
		handle.disposition !== "reused" ||
		handle.receiptId !== request.receiptId ||
		handle.reference.canonicalPath !== reference.canonicalPath ||
		handle.reference.gitCommonDir !== reference.gitCommonDir ||
		handle.reference.gitDir !== reference.gitDir ||
		handle.reference.branch !== reference.branch ||
		handle.reference.head !== reference.head
	) {
		throw new SagaStepError(
			"worktree",
			"existing_worktree_authority_mismatch",
			"existing worktree authority returned a handle outside the durable exact ref",
		);
	}
	return handle;
}

function sameExistingWorktreeHandle(
	left: ResolvedExistingWorktreeHandle,
	right: ResolvedExistingWorktreeHandle,
): boolean {
	return (
		left.claimId === right.claimId &&
		left.receiptId === right.receiptId &&
		left.reference.canonicalPath === right.reference.canonicalPath &&
		left.reference.gitCommonDir === right.reference.gitCommonDir &&
		left.reference.gitDir === right.reference.gitDir &&
		left.reference.head === right.reference.head &&
		left.reference.branch === right.reference.branch
	);
}

export async function revalidateExistingWorktreeHandle(
	request: SagaRequest,
	project: Project,
	provisionedWorktree: ProvisionedAgentWorktree | undefined,
	current: ResolvedExistingWorktreeHandle | undefined,
): Promise<ResolvedExistingWorktreeHandle | undefined> {
	if (!request.existingWorktreeRef) return current;
	const revalidated = await requireExistingWorktreeHandle(request, project);
	if (current && !sameExistingWorktreeHandle(current, revalidated)) {
		throw new SagaStepError(
			"pane",
			"existing_worktree_handle_changed",
			"existing worktree authority returned a different typed handle before pane commit",
		);
	}
	if (
		!provisionedWorktree ||
		provisionedWorktree.path !== revalidated.reference.canonicalPath ||
		provisionedWorktree.branch !== revalidated.reference.branch
	) {
		throw new SagaStepError(
			"pane",
			"existing_worktree_artifact_mismatch",
			"journaled worktree artifact does not match the revalidated checkout",
		);
	}
	return revalidated;
}

export interface SpawnWorktreeIntent extends ProvisionedAgentWorktree {
	agentName: string;
	mode: "planned" | "named";
}

export function worktreeIntentFromReceipt(
	receipt: SpawnReceipt,
): SpawnWorktreeIntent | undefined {
	const detail = receipt.steps.find((step) => step.step === "worktree")?.detail;
	if (!detail || typeof detail !== "object") return undefined;
	const candidate = (detail as Record<string, unknown>).intent;
	if (!candidate || typeof candidate !== "object") return undefined;
	const intent = candidate as Record<string, unknown>;
	const mode = intent.mode;
	return typeof intent.path === "string" &&
		typeof intent.branch === "string" &&
		typeof intent.agentName === "string" &&
		(mode === "planned" || mode === "named")
		? {
				path: intent.path,
				branch: intent.branch,
				agentName: intent.agentName,
				mode,
			}
		: undefined;
}

export async function resolveWorktreeIntent(
	projectPath: string,
	agentName: string,
	worktreePlan: SagaRequest["worktreePlan"],
): Promise<SpawnWorktreeIntent> {
	if (worktreePlan) {
		return {
			path: worktreePlan.worktreePath,
			branch: worktreePlan.branch,
			agentName,
			mode: "planned",
		};
	}
	const [, path, branch] = await worktreeCommand(projectPath, agentName);
	return { path, branch, agentName, mode: "named" };
}

export async function materializeWorktree(
	projectPath: string,
	intent: SpawnWorktreeIntent,
	worktreePlan: SagaRequest["worktreePlan"],
	allowInterruptedAdoption: boolean,
): Promise<{ worktree: ProvisionedAgentWorktree; created: boolean }> {
	const preExisting = await listDir(intent.path)
		.then(() => true)
		.catch(() => false);
	if (preExisting) {
		if (!allowInterruptedAdoption) {
			throw new SagaStepError(
				"worktree",
				"worktree_path_collision",
				`worktree path already exists: ${intent.path}. Select it explicitly as an existing worktree instead of reusing a collision.`,
			);
		}
		const adopted = await provisionWorktree({
			repo: projectPath,
			branch: intent.branch,
			worktreePath: intent.path,
			action: "adopt-worktree",
		});
		// Only a prior journaled worktree intent reaches this branch. It is crash
		// reconciliation for the checkout this saga attempted to create, not an
		// existing-worktree reuse request, so the durable receipt remains created.
		return {
			worktree: requireWorktreeIdentity(intent, adopted),
			created: true,
		};
	}

	if (intent.mode === "planned" && !worktreePlan) {
		throw new SagaStepError(
			"worktree",
			"worktree_plan_missing",
			"durable worktree intent has no provision plan",
		);
	}
	const worktree =
		intent.mode === "planned" && worktreePlan
			? await provisionWorktree({ repo: projectPath, ...worktreePlan })
			: await createWorktree(projectPath, intent.agentName);
	return {
		worktree: requireWorktreeIdentity(intent, worktree),
		created:
			intent.mode === "named" || worktreePlan?.action !== "adopt-worktree",
	};
}

function requireWorktreeIdentity(
	intent: SpawnWorktreeIntent,
	worktree: ProvisionedAgentWorktree,
): ProvisionedAgentWorktree {
	if (worktree.path === intent.path && worktree.branch === intent.branch) {
		return worktree;
	}
	throw new SagaStepError(
		"worktree",
		"worktree_identity_mismatch",
		`expected ${intent.path} (${intent.branch}), got ${worktree.path} (${worktree.branch})`,
	);
}
