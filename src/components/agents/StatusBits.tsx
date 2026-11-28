import { cn } from "@/lib/utils";
import { Titled } from "@/components/ui/tooltip";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { agentStatusMarkData } from "@/lib/agents/agentStatusMark";
import { t } from "@/lib/i18n";

/** An agent's status dot — every surface's, drawn from the one state → mark
 *  table (agentStatusMark.ts) and its stylesheet (agent-status-mark.css):
 *  working green and breathing, a finished turn quiet, needs-you in the
 *  accent, error red, connecting a grey pulse, exited hollow. Unread rings a
 *  live state the person has not looked at yet. An undefined activity
 *  renders a colorless placeholder that only keeps row alignment — the
 *  non-agent-row contract Spaces rows relied on in the former SpaceRowDot. */
export function ActivityDot({
  activity,
  unread,
  className,
}: {
  activity: AgentDisplayState | undefined;
  unread?: boolean;
  className?: string;
}) {
  const label = activity ? activityLabel(activity) : undefined;
  return (
    <Titled title={label}>
      <span
        {...(activity && agentStatusMarkData(activity))}
        className={cn(
          "agent-status-dot",
          activity && activity !== "exited" && unread && "ring-2 ring-ring/50",
          className,
        )}
        aria-label={label}
        role={activity ? "img" : undefined}
      />
    </Titled>
  );
}

export function activityLabel(a: AgentDisplayState): string {
  switch (a) {
    case "unknown":
      return t("agents.status.unknown");
    case "working":
      return t("common.working");
    case "error":
      return t("agents.status.error");
    case "input":
      return t("agents.status.awaitingInput");
    case "blocked":
      return t("agents.status.approvalRequired");
    case "waiting":
      return t("agents.status.awaitingResponse");
    case "connecting":
      return t("common.connecting");
    case "exited":
      return t("common.exited");
  }
}
