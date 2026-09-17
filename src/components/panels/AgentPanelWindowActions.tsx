import type * as React from "react";
import { FileDiff, GitBranch } from "lucide-react";
import type { AgentToolbarGroupPresentation } from "@/components/agents/useAgentToolbarControls";
import { useGitAvailability } from "@/components/scm/useGitAvailability";
import { ToolbarControl } from "@/components/ui/toolbar-control";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { t } from "@/lib/i18n";
import { normalizeDiffBadge } from "@/lib/scm/status/diffBadges";
import { useDiffBadges } from "@/lib/scm/status/diffBadgesStore";
import { cn } from "@/lib/utils";
import {
  openAgentDiffWindow,
  openSourceControlWindow,
} from "@/lib/workspace/window/windows";
import { useStore } from "@/store";
import type { Agent, Project } from "@/types";

interface AgentPanelWindowActionsProps {
  agent: Agent;
  project: Project | undefined;
  /** Whether the diff window can open for this agent. SSH worktrees have no
   * diff window yet, but their fork-point counters still render as a plain
   * indicator so remote and local panes report the same state. */
  showDiff: boolean;
  /** Interface-mode / hidden-control gating resolved by the caller — this
   * component also consumes the existing Git observations below. */
  presentation?: AgentToolbarGroupPresentation<
    "diff-window" | "source-control-window"
  >;
}

/** Secondary-window launchers shared by the agent panel toolbar. */
export function AgentPanelWindowActions({
  agent,
  project,
  showDiff,
  presentation,
}: AgentPanelWindowActionsProps) {
  const slot = (
    id: "diff-window" | "source-control-window",
    node: React.ReactElement,
  ) =>
    presentation === undefined
      ? node
      : presentation.hidden.has(id)
        ? null
        : presentation.slot(id, node);
  const repositoryUsable = useStore((state) =>
    !state.gitStatusErrors[agent.id] &&
    (state.gitStatuses[agent.id]?.isRepo ?? project?.isRepo ?? false),
  );
  const git = useGitAvailability(
    project?.kind === "ssh" ? (project.sshHostId ?? "") : null,
    Boolean(project) && repositoryUsable,
  );
  const storedBadge = useDiffBadges((state) => state.badges[agent.id]);
  if (!project || !repositoryUsable || git.state.status !== "available") return null;
  const badge = storedBadge ? normalizeDiffBadge(storedBadge) : undefined;
  const committedFiles = badge?.committed.files ?? 0;
  const worktreeFiles = badge?.worktree.files ?? 0;
  const ahead = badge?.ahead ?? 0;
  const behind = badge?.behind ?? 0;
  const hasDiffSummary = committedFiles > 0 || worktreeFiles > 0;
  const hasBranchSummary = ahead > 0 || behind > 0;
  const diffTitle = `${t(showDiff ? "panels.agent.window.openDiff" : "common.changes")}${
    hasDiffSummary ? ` · C${committedFiles} W${worktreeFiles}` : ""
  }`;
  const branchTitle = `${t("panels.agent.window.openSourceControl")}${
    hasBranchSummary ? ` · ↑${ahead} ↓${behind}` : ""
  }`;

  return (
    <div
      className="flex shrink-0 items-center gap-0.5"
      data-agent-panel-window-actions
    >
      {(showDiff || hasDiffSummary) &&
        slot(
          "diff-window",
          <ToolbarControl
            label={diffTitle}
          data-agent-pane-status="diff"
          icon={
            <FileDiff
              className={cn(
                "size-3.5 shrink-0",
                // At the tightest widths the counters carry the state and
                // the glyph yields (the pre-unification rule, re-requested
                // 2026-08-31): counts only when narrow, icon + counts when
                // there is room.
                hasDiffSummary && "@max-[280px]/agent-panel-toolbar:hidden",
              )}
            />
          }
          onClick={
            showDiff
              ? () => void openAgentDiffWindow(agent.id, agentDisplayName(agent))
              : undefined
          }
          status={
            hasDiffSummary ? (
              <>
                {committedFiles > 0 && (
                  <span className="font-mono text-meta leading-none text-vcs-added">
                    C{committedFiles}
                  </span>
                )}
                {worktreeFiles > 0 && (
                  <span className="font-mono text-meta leading-none text-vcs-modified">
                    W{worktreeFiles}
                  </span>
                )}
              </>
            ) : null
          }
        />,
        )}
      {slot(
        "source-control-window",
        <ToolbarControl
          label={branchTitle}
        data-agent-pane-status="branch"
        icon={
          <GitBranch
            className={cn(
              "size-3.5 shrink-0",
              hasBranchSummary && "@max-[280px]/agent-panel-toolbar:hidden",
            )}
          />
        }
        onClick={() => void openSourceControlWindow()}
        status={
          hasBranchSummary ? (
            <>
              {ahead > 0 && (
                <span className="font-mono text-meta leading-none">↑{ahead}</span>
              )}
              {behind > 0 && (
                <span className="font-mono text-meta leading-none">↓{behind}</span>
              )}
            </>
          ) : null
        }
      />,
      )}
    </div>
  );
}
