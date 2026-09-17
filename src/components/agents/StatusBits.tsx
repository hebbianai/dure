import { cn } from "@/lib/utils";
import { Titled } from "@/components/ui/tooltip";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { t } from "@/lib/i18n";

/** 상태 점 — AgentActivity의 상위 집합인 AgentDisplayState를 받는다. unread면
 *  링으로 강조 (확인 안 한 input/blocked). An undefined activity renders
 *  a colorless placeholder that only keeps row alignment — the non-agent-row
 *  contract Spaces rows relied on in the former SpaceRowDot. */
export function ActivityDot({
  activity,
  unread,
  className,
}: {
  activity: AgentDisplayState | undefined;
  unread?: boolean;
  className?: string;
}) {
  const meaningful = Boolean(activity && activity !== "exited");
  return (
    <Titled title={activity ? activityLabel(activity) : undefined}>
      <span
        className={cn(
          // 색은 status 토큰으로 — 라이트/다크 변형 포함 하나의 점 팔레트를
          // 모든 표면이 공유한다(옛 spaces/SpaceRowDot 복제본을 여기로 접었다).
          "inline-block size-[7px] shrink-0 rounded-full",
          // The border belongs to the colored vocabulary, not the placeholder.
          activity && "border",
          // Settled work stays static; motion is reserved for transient states.
          activity === "working" &&
            "border-status-warn bg-status-warn",
          activity === "waiting" && "border-status-run bg-status-run",
          activity === "error" && "border-status-error bg-status-error",
          activity === "input" && "border-status-done bg-status-done",
          activity === "blocked" && "border-status-blocked bg-status-blocked",
          // 연결 중은 대기(호박색 고정)와 달리 회색 맥동 — 두 상태는 같은 색이면
          // 구분 불가였다(2026-08-01 UX 검수).
          activity === "connecting" &&
            "animate-pulse border-muted-foreground bg-muted-foreground",
          // 종료는 속이 빈 회색 점 — 무표시면 '죽음'과 '상태 미보고'가 같아 보인다.
          activity === "exited" && "border-muted-foreground/50 bg-transparent",
          activity === "unknown" && "border-muted-foreground bg-muted-foreground",
          meaningful && unread && "ring-2 ring-ring/50",
          className,
        )}
        aria-label={activity ? activityLabel(activity) : undefined}
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
