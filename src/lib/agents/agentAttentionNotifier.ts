// 알림·dot·피드의 단일 신호원 통합 (알림 리치화 §B-②, bd sbm).
//
// attention 에피소드(agentAttentionWatch가 만든 해석-상태 전이)가 유일한
// 사건이고, 시스템 알림은 에피소드에서 파생된다. kind/state는 전이 시점에
// 에피소드에 실려 오므로 여기서 상태를 재해석하지 않는다. 억제(보고 있는
// pane, 설정, 스로틀)는 이 알림 계층에만 산다.

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  type AttentionEpisodeKind,
  useAgentAttention,
} from "@/lib/agents/agentAttentionStore";
import { isDispatchedAgent } from "@/lib/agents/agentDispatchOrigin";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { t } from "@/lib/i18n";
import { pushAgentNotification } from "@/lib/ipc/notifications";
import { selectNotificationPaneTarget } from "@/lib/settings/notificationPaneTarget";
import { notifyPrefs, systemNotify } from "@/lib/settings/notify";
import {
  agentPaneLocations,
  isPanelApiInView,
} from "@/lib/workspace/layout/agentPaneLocations";
import { findAgentPanel } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview, mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { isMainWindow } from "@/lib/workspace/window/windows";
import { useStore } from "@/store";

export type AgentNotificationKind = AttentionEpisodeKind | "exited";

/** 에피소드 kind → 알림 본문. 순수 함수 — 테스트 대상. */
export function episodeNotificationBody(kind: AttentionEpisodeKind): string {
  return kind === "approval"
    ? t("agents.attention.approvalNeeded")
    : t("agents.attention.turnFinished");
}

/** 에피소드 증가분 추출 — subscribe 콜백의 (prev, next)에서 이번에 bump된
 *  agentId 목록을 얻는다. 순수 함수. */
export function diffEpisodeBumps(
  prev: Record<string, number>,
  next: Record<string, number>,
): string[] {
  const bumped: string[] = [];
  for (const [agentId, episode] of Object.entries(next)) {
    if (episode > (prev[agentId] ?? 0)) bumped.push(agentId);
  }
  return bumped;
}

const lastNotified = new Map<string, number>();

/** 시스템 알림 1건 — 설정·가시성 억제·스로틀을 통과할 때만 발송한다. */
export function notifyAgentEvent(
  agentId: string,
  kind: AgentNotificationKind,
  body: string,
  options?: { eventId?: string },
) {
  if (!isMainWindow()) return; // 알림은 메인 창에서만 1회
  const agent = useStore.getState().agents.find((a) => a.id === agentId);
  if (!agent) return;
  // A dispatched worker's completion is not a separate cue for the user.
  // Its unread dot remains; approval and exit still request attention.
  if (kind === "done" && isDispatchedAgent(agent)) return;
  // The phone's preference and recipient authority belong to the paired Hub.
  // Desktop visibility and notification preferences apply only to this screen.
  if (kind !== "exited" && options?.eventId) {
    void pushAgentNotification({ kind, eventId: options.eventId }).catch(() => {
      console.warn("Could not deliver the agent event to paired phone notifications");
    });
  }
  const np = notifyPrefs();
  if (!np.enabled) return;
  if (kind === "done" && !np.agentDone) return;
  if (kind === "approval" && !np.approvalRequired) return;
  if (kind === "exited" && !np.agentExited) return;
  const st = useStore.getState();
  if (np.suppressWhenVisible) {
    const api = getDockview(st.activeSpaceId);
    const panel = api && findAgentPanel(api, agentId);
    // AgentPanel의 unread ack와 같은 술어 — 억제와 ack가 어긋나면 알림 없이
    // 보이지 않는 dot만 남는다 (최대화된 다른 그룹 케이스).
    if (isPanelApiInView(panel?.api, document.hasFocus())) return;
  }
  // Host 사건은 native adapter의 bounded exact-id receipt가 중복을 판정한다.
  // 서로 다른 연속 counter를 시간 throttle로 잃지 않도록 legacy에만 적용한다.
  if (!options?.eventId) {
    const now = Date.now();
    const notificationId = `${agentId}:${kind}`;
    if (now - (lastNotified.get(notificationId) ?? 0) < 2_000) return;
    lastNotified.set(notificationId, now);
  }
  const project = st.projects.find((p) => p.id === agent.projectId);
  const displayName = agentDisplayName(agent);
  const title = project ? `${displayName} · ${project.name}` : displayName;
  const mounted = mountedDockviewEntries();
  const candidates = agentPaneLocations(st.layouts, mounted).filter(
    (pane) => pane.agentId === agentId,
  );
  const mountedSpaces = new Set(mounted.map(([desktopId]) => desktopId));
  const mountedCandidates = candidates.filter((pane) => mountedSpaces.has(pane.desktopId));
  const paneTarget = selectNotificationPaneTarget(
    st.activeSpaceId,
    mountedCandidates.length > 0 ? mountedCandidates : candidates,
  );
  void systemNotify(title, body, {
    eventId: options?.eventId,
    paneTarget: paneTarget
      ? { ...paneTarget, windowLabel: getCurrentWebviewWindow().label }
      : undefined,
  });
}

/** 에피소드 → 알림 구독 설치. 메인 창에서 1회 호출한다. 권한 판정과 receipt는
 * native adapter가 소유하고, 부팅 중에는 권한을 요청하지 않는다. */
export function installAgentAttentionNotifier(): () => void {
  return useAgentAttention.subscribe((state, previous) => {
    // Display-only refreshes do not require notification work.
    if (state.episodes === previous.episodes) return;
    for (const agentId of diffEpisodeBumps(previous.episodes, state.episodes)) {
      const kind = state.episodeKinds[agentId] ?? "done";
      notifyAgentEvent(agentId, kind, episodeNotificationBody(kind), {
        eventId: state.episodeIds[agentId],
      });
    }
  });
}
