// Pure request parsing for the spawn saga — extracted so the wire contract
// is unit-testable without pulling the saga's dock/store dependency graph.
//
// The parsed request is persisted verbatim by the backend before the saga
// runs (crash safety), so every field added here must stay JSON-plain and
// resumable: a rehydrated request from the sp_* journal goes through this
// exact parser again.

import type {
  ExistingWorktreeRef,
  WorktreeProvisionPlan,
} from "@/lib/ipc";
// Type-only import — erased at runtime, so this module stays store/dock-free.
import type { PaneSplitDirection } from "@/lib/workspace/dock";
import { PROVIDERS } from "@/types";
import type { Provider, TerminalEnvironment } from "@/types";

export interface SagaPlacement {
  referenceSessionId: string;
  referencePanelId?: string;
  direction: PaneSplitDirection;
}

/** Dialog-computed worktree plan, the exact subset provisionWorktree consumes.
 *  The saga never re-plans: a resumed run must provision the same path and
 *  branch the user confirmed, even if the repository moved since. */
type SagaWorktreePlan = Omit<WorktreeProvisionPlan, "repo">;

export interface SagaRequest {
  receiptId: string;
  project: string;
  name?: string;
  provider: Provider;
  prompt?: string;
  useWorktree: boolean;
  runtime: "legacy" | "hmux";
  /** Which space the pane opens in.
   *
   *  Carried in the request rather than read from the store at pane time
   *  because the store's answer is "whatever is active *now*", and a saga can
   *  run long after it was asked for — a phone's request while nobody is at
   *  the desk, or a resume after a reload. The journal is the authority on
   *  everything else the person chose; this is one of those things. Absent
   *  means the active space, which is what an in-app dialog wants. */
  spaceId?: string;
  placement?: SagaPlacement;
  permissionMode?: string;
  /** null explicitly pins the provider's default credential. */
  accountId?: string | null;
  terminalEnv?: TerminalEnvironment;
  worktreePlan?: SagaWorktreePlan;
  existingWorktreeRef?: ExistingWorktreeRef;
}

export class SagaStepError extends Error {
  constructor(
    readonly step: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SagaStepError";
  }
}

const WORKTREE_ACTIONS = new Set([
  "create-new-branch",
  "checkout-existing-branch",
]);

function parseWorktreePlan(raw: unknown): SagaWorktreePlan | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    throw new SagaStepError(
      "preflight",
      "invalid_request",
      "worktreePlan must be an object",
    );
  }
  const plan = raw as Record<string, unknown>;
  const branch = typeof plan.branch === "string" ? plan.branch.trim() : "";
  const worktreePath =
    typeof plan.worktreePath === "string" ? plan.worktreePath.trim() : "";
  const action = String(plan.action ?? "");
  if (!branch || !worktreePath || !WORKTREE_ACTIONS.has(action)) {
    throw new SagaStepError(
      "preflight",
      "invalid_request",
      "worktreePlan requires branch, worktreePath and a known action",
    );
  }
  return {
    branch,
    worktreePath,
    action: action as SagaWorktreePlan["action"],
    ...(typeof plan.baseRef === "string" && plan.baseRef
      ? { baseRef: plan.baseRef }
      : {}),
    ...(typeof plan.worktreeRoot === "string" && plan.worktreeRoot
      ? { worktreeRoot: plan.worktreeRoot }
      : {}),
  };
}

function parseAccountId(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  throw new SagaStepError(
    "preflight",
    "invalid_request",
    "accountId must be a non-empty string or null",
  );
}

function absolutePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const path = value.trim();
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) ? path : undefined;
}

function parseExistingWorktreeRef(raw: unknown): ExistingWorktreeRef | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    throw new SagaStepError(
      "preflight",
      "invalid_request",
      "existingWorktreeRef must be an object",
    );
  }
  const value = raw as Record<string, unknown>;
  const canonicalPath = absolutePath(value.canonicalPath);
  const gitCommonDir = absolutePath(value.gitCommonDir);
  const gitDir = absolutePath(value.gitDir);
  const branch = typeof value.branch === "string" ? value.branch.trim() : "";
  const head = typeof value.head === "string" ? value.head.trim().toLowerCase() : "";
  if (
    !canonicalPath ||
    !gitCommonDir ||
    !gitDir ||
    !branch ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)
  ) {
    throw new SagaStepError(
      "preflight",
      "invalid_request",
      "existingWorktreeRef requires canonical Git paths, branch and an exact HEAD",
    );
  }
  return { canonicalPath, gitCommonDir, gitDir, branch, head };
}

export function parseSagaRequest(params: Record<string, unknown>): SagaRequest {
  const provider = String(params.provider ?? "claude") as Provider;
  if (!(provider in PROVIDERS)) {
    throw new SagaStepError(
      "preflight",
      "invalid_request",
      `unsupported provider: ${provider}`,
    );
  }
  const runtime = String(params.runtime ?? "legacy");
  if (runtime !== "legacy" && runtime !== "hmux") {
    throw new SagaStepError(
      "preflight",
      "invalid_request",
      `unsupported runtime: ${runtime}`,
    );
  }
  let placement: SagaPlacement | undefined;
  const rawPlacement = params.placement as Record<string, unknown> | undefined;
  if (rawPlacement && typeof rawPlacement === "object") {
    const direction = String(rawPlacement.direction ?? "below");
    if (direction !== "right" && direction !== "below") {
      throw new SagaStepError(
        "preflight",
        "invalid_request",
        "placement.direction must be right or below",
      );
    }
    placement = {
      referenceSessionId: String(rawPlacement.referenceSessionId ?? ""),
      referencePanelId: rawPlacement.referencePanelId
        ? String(rawPlacement.referencePanelId)
        : undefined,
      direction: direction as PaneSplitDirection,
    };
    if (!placement.referenceSessionId) {
      throw new SagaStepError(
        "preflight",
        "invalid_request",
        "placement.referenceSessionId is required",
      );
    }
  }
  const useWorktree = params.useWorktree !== false;
  const worktreePlan = parseWorktreePlan(params.worktreePlan);
  const existingWorktreeRef = parseExistingWorktreeRef(
    params.existingWorktreeRef,
  );
  if (worktreePlan && existingWorktreeRef) {
    throw new SagaStepError(
      "preflight",
      "invalid_request",
      "worktreePlan and existingWorktreeRef are mutually exclusive",
    );
  }
  if (!useWorktree && (worktreePlan || existingWorktreeRef)) {
    throw new SagaStepError(
      "preflight",
      "invalid_request",
      "worktree inputs require useWorktree=true",
    );
  }
  return {
    receiptId: String(params.receiptId ?? ""),
    project: String(params.project ?? ""),
    name: params.name ? String(params.name) : undefined,
    provider,
    prompt: params.prompt ? String(params.prompt) : undefined,
    useWorktree,
    runtime,
    spaceId: params.spaceId ? String(params.spaceId) : undefined,
    placement,
    permissionMode: params.permissionMode
      ? String(params.permissionMode)
      : undefined,
    accountId: parseAccountId(params.accountId),
    terminalEnv: params.terminalEnv as TerminalEnvironment | undefined,
    worktreePlan,
    existingWorktreeRef,
  };
}
