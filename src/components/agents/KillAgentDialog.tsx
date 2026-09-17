// Agent removal confirmation with optional dedicated-worktree cleanup.
// The dirty count is a preview; Git remains the destructive admission authority.

import { ConfirmationButton } from "@/components/ui/button";
import { Check, Circle } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { useEffect, useRef, useState } from "react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorText } from "@/components/ui/error-text";
import { InsetPanel } from "@/components/ui/inset-panel";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { sameAgentRemovalPreview } from "@/lib/agents/agentRemovalPreview";
import {
	agentRemovalRegistrationIdentity,
	sameAgentRemovalTarget,
} from "@/lib/agents/agentRemovalRegistration";
import { projectCanonicalAgentStopV1 } from "@/lib/agents/canonicalAgentStopLifecycle";
import { CanonicalAgentStopRetainedError } from "@/lib/agents/canonicalAgentStopRuntime";
import {
	type AgentRemovalPreview,
	type AgentRemovalProgress,
	AgentRemovalScopeChangedError,
	AgentRemovalWorktreeUnsupportedError,
	executeAgentRemoval,
	type PreparedAgentRemoval,
	prepareAgentRemoval,
} from "@/lib/agents/resourceLifecycle";
import { t } from "@/lib/i18n";
import { gitStatus } from "@/lib/ipc";
import { planAgentWorktreeRemoval } from "@/lib/scm/worktrees/worktreeRemoval";
import { useStore } from "@/store";
import { type Agent, PROVIDERS } from "@/types";

type RemovalStepStatus = "pending" | "active" | "completed" | "failed";

type RemovalStep =
  | {
      key: string;
      kind: "agent";
      agent: Agent;
      status: RemovalStepStatus;
    }
  | {
      key: string;
      kind: "worktree";
      path: string;
      status: RemovalStepStatus;
    };

function progressKey(progress: AgentRemovalProgress): string {
  return progress.kind === "agent"
    ? `agent:${progress.agentId}`
    : `worktree:${progress.path}`;
}

function removalSteps(preview: AgentRemovalPreview): RemovalStep[] {
  return [
    ...preview.agents.map(
      (candidate): RemovalStep => ({
        key: `agent:${candidate.id}`,
        kind: "agent",
        agent: candidate,
        status: "pending",
      }),
    ),
    ...(preview.worktree && !preview.worktreeAlreadyAbsent
      ? [
          {
            key: `worktree:${preview.worktree.wtPath}`,
            kind: "worktree" as const,
            path: preview.worktree.wtPath,
            status: "pending" as const,
          },
        ]
      : []),
  ];
}

function removalConfirmation(agent: Agent) {
  const state = useStore.getState();
  return {
    agent,
    worktree: agent.canonicalSpawn ? null : planAgentWorktreeRemoval(
      agent, state.projects.find((project) => project.id === agent.projectId),
    ),
  };
}

export function KillAgentDialog({
  agent,
  onClose,
}: {
  agent: Agent;
  onClose: () => void;
}) {
  // Confirmation facts stay visible even after lifecycle cleanup removes the
  // underlying registrations from the live store.
  const [confirmation, setConfirmation] = useState(() =>
    removalConfirmation(agent),
  );
  const { agent: confirmedAgent, worktree } = confirmation;
  const expectedIdentity = agentRemovalRegistrationIdentity(confirmedAgent);
	const initialRemovalPreview: AgentRemovalPreview | null = worktree
		? {
				agents: [confirmedAgent],
				worktree,
			}
		: null;
  // 워크트리 삭제는 되돌릴 수 없어 기본값은 보존(false)이다.
  const [deleteWorktree, setDeleteWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [steps, setSteps] = useState<RemovalStep[]>([]);
  const [error, setError] = useState<string | null>(null);
	const [confirmationPreview, setConfirmationPreview] =
		useState<AgentRemovalPreview | null>(null);
  const operationRef = useRef<PreparedAgentRemoval | null>(null);
	const displayedRemovalPreview = confirmationPreview ?? initialRemovalPreview;
  // 미커밋 변경 수 — null: 조회 중, "unknown": 확인 불가(원격·오류)
  const [dirtyCount, setDirtyCount] = useState<number | "unknown" | null>(null);
  const worktreeKind = worktree?.kind ?? null;
  const worktreePath = worktree?.kind === "local" ? worktree.wtPath : null;
  useEffect(() => {
    if (!worktreePath) {
      setDirtyCount(worktreeKind ? "unknown" : null);
      return;
    }
    let cancelled = false;
    setDirtyCount(null);
    gitStatus(worktreePath)
      .then((status) => {
        if (cancelled) return;
        setDirtyCount(status.staged + status.unstaged + status.untracked);
      })
      .catch(() => {
        if (!cancelled) setDirtyCount("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [worktreePath, worktreeKind]);

  const confirm = async () => {
    setBusy(true);
    setCompleted(false);
    setError(null);
    try {
      let operation = operationRef.current;
      if (!operation) {
        operation = await prepareAgentRemoval(agent.id, {
					deleteWorktree: Boolean(worktree) && deleteWorktree,
					expectedIdentity,
        });
        operationRef.current = operation;
				if (deleteWorktree) {
					const confirmedScope = displayedRemovalPreview;
					setConfirmationPreview(operation.preview);
					if (
						confirmedScope &&
						!sameAgentRemovalPreview(confirmedScope, operation.preview)
					) {
						setError(t("agents.remove.confirmationUpdated"));
						return;
      }
				}
			}
			if (steps.length === 0) setSteps(removalSteps(operation.preview));
      await executeAgentRemoval(operation, {
        onProgress: (progress) => {
          const key = progressKey(progress);
          setSteps((current) =>
            current.map((step) =>
              step.key === key
                ? {
                    ...step,
                    status:
                      progress.status === "started" ? "active" : "completed",
                  }
                : step,
            ),
          );
        },
      });
      setSteps((current) =>
        current.map((step) => ({ ...step, status: "completed" })),
      );
      setCompleted(true);
    } catch (e) {
      let message = e instanceof Error ? t(e.message) : String(e);
			if (e instanceof AgentRemovalWorktreeUnsupportedError) {
				operationRef.current = null;
				setSteps([]);
				setConfirmationPreview(e.preview);
			} else if (
				(e instanceof AgentRemovalScopeChangedError && e.retry === "reprepare") ||
				(e instanceof CanonicalAgentStopRetainedError &&
					projectCanonicalAgentStopV1(e.receipt).kind === "source_retained")
			) {
				operationRef.current = null;
				setSteps([]);
				setConfirmationPreview(null);
				const current = useStore.getState().agents.find((candidate) => candidate.id === agent.id);
				if (current) {
					setConfirmation(removalConfirmation(current));
					if (!sameAgentRemovalTarget(current, expectedIdentity)) {
						message = t("agents.remove.confirmationUpdated");
					}
				}
			}
      setSteps((current) =>
        current.map((step) =>
          step.status === "active" ? { ...step, status: "failed" } : step,
        ),
      );
      setError(message);
    } finally {
      setBusy(false);
    }
  };

	const completedSteps = steps.filter(
		(step) => step.status === "completed",
	).length;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!busy}
        dismiss={busy ? "none" : "all"}
      >
        <DialogHeader>
          <DialogTitle>{t("common.removeAgent")}</DialogTitle>
          <DialogDescription>
            {t("agents.remove.confirmDescription", {
              name: agentDisplayName(confirmedAgent),
            })}
          </DialogDescription>
        </DialogHeader>
        {worktree && (
          <InsetPanel className="border-border bg-muted/40">
            <div className="flex items-center justify-between gap-3">
							<Label
								htmlFor="delete-worktree"
								className="min-w-0 cursor-pointer text-xs leading-relaxed"
							>
                {t("agents.remove.alsoDeleteWorktree")}
                <span className="mt-0.5 block font-mono text-[10px] break-all text-muted-foreground">
                  {worktree.wtPath}
                </span>
              </Label>
              <Switch
                id="delete-worktree"
                checked={deleteWorktree}
								onCheckedChange={(checked) => {
									setDeleteWorktree(checked);
									if (!checked && steps.length === 0) {
										operationRef.current = null;
										setConfirmationPreview(null);
										setError(null);
                }
								}}
								disabled={busy || completed || steps.length > 0}
              />
            </div>
						{deleteWorktree && displayedRemovalPreview && (
              <div className="mt-2 rounded border border-destructive/25 bg-destructive/5 p-2">
                <p className="text-[11px] font-medium leading-relaxed text-destructive">
                  {displayedRemovalPreview.worktreeAlreadyAbsent ? t("agents.remove.worktreeAlreadyAbsent") : t("agents.remove.worktreeWithAgents", {
										n: displayedRemovalPreview.agents.length,
                  })}
                </p>
                <ul className="mt-1.5 max-h-28 space-y-1 overflow-auto">
									{displayedRemovalPreview.agents.map((affected) => (
										<li
											key={affected.id}
											className="flex min-w-0 items-center gap-1.5 text-[10px]"
										>
											<ProviderGlyph
												provider={affected.provider}
												className="size-3"
											/>
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {agentDisplayName(affected)}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
												{PROVIDERS[affected.provider].label} ·{" "}
												{t("agents.remove.deleteSessionAndRegistration")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!displayedRemovalPreview?.worktreeAlreadyAbsent && typeof dirtyCount === "number" && dirtyCount > 0 && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-destructive">
                {t("agents.remove.uncommittedChangesWarning", {
                  n: dirtyCount,
                })}
              </p>
            )}
            {!displayedRemovalPreview?.worktreeAlreadyAbsent && dirtyCount === "unknown" && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {t("agents.remove.uncommittedCheckFailed")}
              </p>
            )}
          </InsetPanel>
        )}
        {steps.length > 0 && (
          <InsetPanel aria-live="polite">
            <p className="mb-2 text-[11px] font-medium text-foreground">
							{completedSteps}/{steps.length} ·{" "}
							{completed
								? t("common.done")
								: error
									? t("common.failed")
									: t("common.removing")}
            </p>
            <ul className="max-h-40 space-y-1.5 overflow-auto">
              {steps.map((step) => {
                const statusLabel =
                  step.status === "completed"
                    ? t("common.done")
                    : step.status === "active"
                      ? t("common.removing")
                      : step.status === "failed"
                        ? t("common.failed")
                        : t("common.waiting");
                return (
									<li
										key={step.key}
										className="flex min-w-0 items-start gap-2 text-[11px]"
									>
                    <span className="mt-0.5 flex size-3 shrink-0 items-center justify-center">
                      {step.status === "completed" ? (
                        <Check className="size-3 text-status-run" />
                      ) : step.status === "active" ? (
                        <DureLoader decorative className="text-status-warn" />
                      ) : (
                        <Circle
                          className={
                            step.status === "failed"
                              ? "size-2.5 fill-destructive text-destructive"
                              : "size-2.5 text-muted-foreground/50"
                          }
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      {step.kind === "agent" ? (
                        <>
                          <span className="block truncate text-foreground">
                            {agentDisplayName(step.agent)}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
														{PROVIDERS[step.agent.provider].label} ·{" "}
														{t("agents.remove.deleteSessionAndRegistration")}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="block text-foreground">
                            {t("agents.remove.alsoDeleteWorktree")}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">
                            {step.path}
                          </span>
                        </>
                      )}
                    </span>
                    <span
                      className={
                        step.status === "failed"
                          ? "shrink-0 text-destructive"
                          : "shrink-0 text-muted-foreground"
                      }
                    >
                      {statusLabel}
                    </span>
                  </li>
                );
              })}
            </ul>
          </InsetPanel>
        )}
        {error && <ErrorText className="break-all">{error}</ErrorText>}
        {completed ? (
          <DialogFooter>
            <ConfirmationButton onClick={onClose}>{t("common.close")}</ConfirmationButton>
          </DialogFooter>
        ) : (
          <DialogActionFooter
            cancelLabel={t("common.cancel")}
            onCancel={onClose}
            confirmLabel={t("common.remove")}
            busyLabel={t("common.removing")}
            busy={busy}
            variant="destructive"
            onConfirm={confirm}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
