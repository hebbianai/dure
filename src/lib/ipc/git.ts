// ipc/git — git·워크트리 프로비저닝.
//
// ipc.ts 도메인 분할 1단계(2026-08-01): 내용은 구 src/lib/ipc.ts에서 그대로
// 옮겨졌고, 소비자는 barrel(src/lib/ipc.ts)을 통해 기존 경로를 유지한다.
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).

import { invoke } from "@tauri-apps/api/core";
import {
	GitCheckoutCommandError,
	type GitCheckoutCommandErrorCode,
	type GitCheckoutInstanceV1,
	type GitCheckoutRemovalPolicyV1,
	parseGitCheckoutRemovalReceipt,
	parseLocalGitCheckoutInstance,
	parseLocalGitCheckoutLocations,
} from "@/lib/scm/worktrees/gitCheckoutInstance";
import {
	parseRemoteGitCheckoutHelperPath,
	type RemoteGitCheckoutHelperPath,
} from "@/lib/scm/worktrees/remoteGitCheckoutHelper";
import type {
	BranchInfo as WorktreeBranchInfo,
	WorktreeAction as WorktreeProvisionAction,
} from "@/lib/scm/worktrees/worktreePlan";
import type { TrustedSshTargetV1 } from "@/lib/ssh/trustedSshTarget";
import type { SystemResources } from "@/lib/usage/systemResources";
import type { DetectedWorktree, GitStatus, SshHostConfig } from "@/types";
import type { DirEntry, ExecResult } from "./hmux";
import { hostToOpts } from "./sessions";

// ---------- git / fs ----------

export const gitStatus = (path: string) =>
	invoke<GitStatus>("git_status", { path });

export type GitAvailability =
  | { status: "available" }
  | { status: "missing" }
  | { status: "unknown"; detail: string };

/** Check the execution host, independently of whether a folder is a repository. */
export async function gitAvailability(host: SshHostConfig | null): Promise<GitAvailability> {
  const result = await invoke<GitAvailability>("git_availability", {
    opts: host ? hostToOpts(host) : null,
  });
  if (result?.status === "available" || result?.status === "missing") return result;
  if (result?.status === "unknown" && typeof result.detail === "string") return result;
  throw new Error("Invalid Git availability response");
}

/** 로컬 repo에서 git 서브커맨드 실행 (원격은 sessions의 sshExecOnce). */
export const gitExecLocal = (path: string, args: string[]) =>
	invoke<ExecResult>("git_exec", { path, args });

/** Timeout-bounded variant of gitExecLocal — for best-effort subcommands
 *  (e.g. a default-branch fetch/probe) that must never block the caller
 *  indefinitely. On timeout the backend returns the fixed
 *  `{ stdout: "", stderr: "git_exec_timeout", code: -1 }` contract. */
export const gitExecLocalBounded = (
	path: string,
	args: string[],
	timeoutMs: number,
) => invoke<ExecResult>("git_exec_bounded", { path, args, timeoutMs });

export const createWorktree = (repo: string, name: string, from?: string) =>
	invoke<{ path: string; branch: string }>("create_worktree", {
		repo,
		name,
		from: from ?? null,
	});

function gitCheckoutBackendError(
	error: unknown,
	fallbackCode: GitCheckoutCommandErrorCode,
): GitCheckoutCommandError {
	if (error instanceof GitCheckoutCommandError) return error;
	const payload =
		error && typeof error === "object"
			? (error as Record<string, unknown>)
			: undefined;
	const backendCode =
		typeof payload?.code === "string" ? payload.code : undefined;
	const detail =
		typeof payload?.message === "string"
			? payload.message
			: error instanceof Error
				? error.message
				: String(error);
	const code: GitCheckoutCommandErrorCode =
		backendCode === "worktree_identity_changed" ||
		backendCode === "worktree_remove_failed" ||
		backendCode === "worktree_capture_failed" ||
		backendCode === "worktree_request_invalid"
			? backendCode
			: fallbackCode;
	const message =
		backendCode && backendCode !== code ? `${backendCode}: ${detail}` : detail;
	return new GitCheckoutCommandError(code, message);
}

/** Capture one local linked-checkout generation before lifecycle mutation. */
export const captureGitCheckoutInstance = (
	repo: string,
	worktreePath: string,
) =>
	invoke<unknown>("capture_git_checkout_instance", {
		repo,
		worktreePath,
	})
		.then(parseLocalGitCheckoutInstance)
		.catch((error) => {
			throw gitCheckoutBackendError(error, "worktree_capture_failed");
		});

/** Resolve checkout locations in one backend-owned filesystem observation. */
export const locateGitCheckoutPaths = (paths: readonly string[]) =>
	invoke<unknown>("locate_git_checkout_paths", { paths })
		.then((locations) => parseLocalGitCheckoutLocations(locations, paths))
		.catch((error) => {
			throw gitCheckoutBackendError(error, "worktree_location_failed");
		});

/** Remove only the captured local checkout generation through plain Git admission. */
export const removeGitCheckoutInstance = (
	repo: string,
	instance: GitCheckoutInstanceV1,
	policy: GitCheckoutRemovalPolicyV1,
) =>
	invoke<unknown>("remove_git_checkout_instance", {
		repo,
		instance,
		policy,
	})
		.then((receipt) => parseGitCheckoutRemovalReceipt(receipt, instance))
		.catch((error) => {
			throw gitCheckoutBackendError(error, "worktree_remove_failed");
		});

/** Installs and returns one exact content-addressed checkout helper on an SSH Host. */
export async function prepareRemoteGitCheckoutHelper(
	target: TrustedSshTargetV1,
): Promise<RemoteGitCheckoutHelperPath> {
	const { schemaVersion: _schemaVersion, hostId: _hostId, ...opts } = target;
	try {
		return parseRemoteGitCheckoutHelperPath(
			await invoke<unknown>("prepare_remote_git_checkout_helper", { opts }),
		);
	} catch (error) {
		throw new GitCheckoutCommandError(
			"remote_git_checkout_capability_unavailable",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export const worktreeCommand = (repo: string, name: string, from?: string) =>
	invoke<[string, string, string]>("worktree_command", {
		repo,
		name,
		from: from ?? null,
	});

// --- 브랜치 명시 워크트리 프로비저닝 (hebbian-frontend-qvu) ---
// 와이어 타입은 순수 planner(worktreePlan.ts)의 것을 재사용해 typecheck로 계약을
// 고정한다(별도 재선언 금지).
export const listBranches = (repo: string) =>
	invoke<WorktreeBranchInfo[]>("list_branches", { repo });
export const listBranchesCommand = (repo: string) =>
	invoke<string>("list_branches_command", { repo });
export const parseBranches = (output: string) =>
	invoke<WorktreeBranchInfo[]>("parse_branches", { output });

export interface WorktreeProvisionPlan {
	repo: string;
	branch: string;
	worktreePath: string;
	action: WorktreeProvisionAction; // "create-new-branch" | "checkout-existing-branch" | "adopt-worktree"
	baseRef?: string;
	/** 워크트리를 담을 레포 기준 상대 디렉터리(`.worktrees/`, `../` 등).
	 *  전체 경로가 아니라 루트만 — 백엔드가 검증 후 조립한다. */
	worktreeRoot?: string;
}
export const provisionWorktree = (plan: WorktreeProvisionPlan) =>
	invoke<{ path: string; branch: string }>("provision_worktree", {
		plan: { ...plan, baseRef: plan.baseRef ?? null },
	});
export const provisionWorktreeCommand = (plan: WorktreeProvisionPlan) =>
	invoke<[string, string]>("provision_worktree_command", {
		plan: { ...plan, baseRef: plan.baseRef ?? null },
	});

/** markIgnored를 켜면 git check-ignore로 항목마다 무시 여부를 채운다 —
 *  숨길 이유가 없을 때는 켜지 않는다(목록마다 git 프로세스가 하나 뜬다). */
export const listDir = (
	path: string,
	includeHidden = false,
	markIgnored = false,
) => invoke<DirEntry[]>("list_dir", { path, includeHidden, markIgnored });

/** 상태 표시줄 자원 위젯의 표본. path는 디스크 여유를 잴 볼륨 선택에만 쓴다. */
export const systemResources = (path?: string) =>
	invoke<SystemResources>("system_resources", { path });

export const createAccountDir = (provider: string, name: string) =>
	invoke<string>("create_account_dir", { provider, name });

export interface RemoteDirectoryListing {
	path: string;
	entries: DirEntry[];
	isRepo: boolean;
}

/** Both directory surfaces read the same remote filesystem snapshot. */
export const browseRemoteDirectory = (host: SshHostConfig, path?: string) =>
	invoke<RemoteDirectoryListing>("ssh_browse_directory", {
		opts: hostToOpts(host),
		path,
	});

export const remoteProjectDirectory = (host: SshHostConfig, path: string) =>
	invoke<{ path: string; isRepo: boolean; origin: string | null }>(
		"ssh_project_directory",
		{
			opts: hostToOpts(host),
			path,
		},
	);

export async function listRemoteDir(
	host: SshHostConfig,
	path: string,
	includeHidden = false,
): Promise<DirEntry[]> {
	const listing = await browseRemoteDirectory(host, path);
	return listing.entries.filter(
		(entry) => includeHidden || !entry.name.startsWith("."),
	);
}

export const scanWorktrees = (repo: string) =>
	invoke<DetectedWorktree[]>("scan_worktrees", { repo });

export const scanWorktreesCommand = (repo: string) =>
	invoke<string>("scan_worktrees_command", { repo });

export const parseWorktreeScan = (output: string) =>
	invoke<DetectedWorktree[]>("parse_worktree_scan", { output });

/** Backend-observed identity for one exact Git linked worktree. Path alone is
 * never sufficient: branch/HEAD and both Git directory identities are pinned
 * so a later checkout change fails closed before pane/runtime mutation. */
export interface ExistingWorktreeRef {
	canonicalPath: string;
	gitCommonDir: string;
	gitDir: string;
	branch: string;
	head: string;
}

export type ExistingWorktreeOwnershipState =
	| "unowned"
	| "live_owned"
	| "stale_owned"
	| "reserved"
	| "ambiguous";

export interface ExistingWorktreeOwner {
	agentId: string;
	provider: string;
	channel: string;
	runtimeLiveness: "live" | "dead" | "unknown";
	paneLiveness: "live" | "dead" | "unknown";
}

export interface ExistingWorktreeOwnership {
	state: ExistingWorktreeOwnershipState;
	owners?: ExistingWorktreeOwner[];
	claimReceiptId?: string;
}

export interface ExistingWorktreeCandidate {
	reference: ExistingWorktreeRef;
	isMain: boolean;
	ownership: ExistingWorktreeOwnership;
}

export interface ExistingWorktreeList {
	repository: { canonicalPath: string; gitCommonDir: string };
	worktrees: ExistingWorktreeCandidate[];
	limit: number;
	truncated: boolean;
}

export interface ResolvedExistingWorktreeHandle {
	reference: ExistingWorktreeRef;
	disposition: "reused";
	claimId: string;
	receiptId: string;
}

export type ExistingWorktreeResolution =
	| { state: "resolved"; handle: ResolvedExistingWorktreeHandle }
	| {
			state: "refused";
			code: string;
			message: string;
			recovery: string;
	  };

export const listExistingWorktrees = (repo: string, preferredPath?: string) =>
	invoke<ExistingWorktreeList>("list_existing_worktrees", {
		repo,
		preferredPath: preferredPath ?? null,
	});

export const inspectExistingWorktree = (
	repo: string,
	reference: ExistingWorktreeRef,
) =>
	invoke<ExistingWorktreeCandidate>("inspect_existing_worktree", {
		repo,
		reference,
	});

export const resolveExistingWorktree = (
	repo: string,
	reference: ExistingWorktreeRef,
	receiptId: string,
) =>
	invoke<ExistingWorktreeResolution>("resolve_existing_worktree", {
		repo,
		reference,
		receiptId,
	});

export type ExistingWorktreeRecovery =
	| {
			state: "recovered";
			claimId?: string;
			receiptId?: string;
			outcome: "released" | "owners_released" | "already_recovered";
	  }
	| {
			state: "refused";
			code: string;
			message: string;
			recovery: string;
	  };

/** Explicit stale-ownership recovery. The backend either releases a terminal
 * claim or removes one dead-channel registry owner after proving its runtime
 * and pane dead. It never changes the checkout or terminates a live resource. */
export const recoverExistingWorktreeOwnership = (
	repo: string,
	reference: ExistingWorktreeRef,
	expectedReceiptId?: string,
) =>
	invoke<ExistingWorktreeRecovery>("recover_existing_worktree_ownership", {
		repo,
		reference,
		expectedReceiptId: expectedReceiptId ?? null,
	});

export const copyClaudeSession = (
	fromCwd: string,
	toCwd: string,
	convId: string,
) => invoke<void>("copy_claude_session", { fromCwd, toCwd, convId });

export const copyClaudeSessionCommand = (
	fromCwd: string,
	toCwd: string,
	convId: string,
) => invoke<string>("copy_claude_session_command", { fromCwd, toCwd, convId });

// 프로세스 수명 동안 불변인 값 — pane마다 IPC를 반복하지 않도록 메모이즈.
// 실패는 캐시하지 않아 일시 오류가 영구화되지 않는다.
let homeDirPromise: Promise<string> | undefined;
export const homeDir = () =>
	(homeDirPromise ??= invoke<string>("home_dir").catch((error) => {
		homeDirPromise = undefined;
		throw error;
	}));
