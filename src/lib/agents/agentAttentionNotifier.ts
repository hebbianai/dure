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
import { pendingApproval } from "@/lib/agents/approvalRequest";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { agentNotificationsMuted } from "@/lib/agents/agentNotificationMute";
import { agentRelationsOf } from "@/lib/agents/relations/agentRelationFacts";
import { agentSeatKey, chatOwnedAgent } from "@/lib/hub/sidebarLayout";
import { t } from "@/lib/i18n";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import {
  type NotificationDispatchReceipt,
  pushAgentNotification,
} from "@/lib/ipc/notifications";
import { selectNotificationPaneTarget } from "@/lib/settings/notificationPaneTarget";
import { notifyPrefs, systemNotify } from "@/lib/settings/notify";
import {
  agentPaneLocations,
  isAgentPaneSeen,
} from "@/lib/workspace/layout/agentPaneLocations";
import { findAgentPanel } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview, mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { isMainWindow } from "@/lib/workspace/window/windows";
import { useStore } from "@/store";

export type AgentNotificationKind = AttentionEpisodeKind | "exited" | "message";

type PhonePushKind = Parameters<typeof pushAgentNotification>[0]["kind"];

/**
 * How one kind of agent event reaches the person: which switch enables it,
 * whether a visible pane, a dispatched worker or a manager silences it, and
 * which phone push it rides. Every kind, including a new one, is decided here.
 */
interface AgentNotificationPolicy {
  /** The Settings switch that turns this kind's desktop notification on. */
  readonly pref: "agentDone" | "approvalRequired" | "agentExited" | "agentMessage";
  /** Whether "Suppress while focused" applies to this kind. */
  readonly suppressWhenVisible: boolean;
  /** Whether a dispatched worker's event is a separate cue for the person. */
  readonly dispatchedWorkers: boolean;
  /** For an agent another agent manages: the Settings switch that lets it
   *  tell the person of this kind itself, or null when it always does. */
  readonly managedAgents: "managedAgentDone" | null;
  /** The phone push kind the event rides, or none. */
  readonly phone: PhonePushKind | null;
}

const NOTIFICATION_POLICY: Readonly<Record<AgentNotificationKind, AgentNotificationPolicy>> = {
  approval: { pref: "approvalRequired", suppressWhenVisible: true, dispatchedWorkers: true, managedAgents: null, phone: "approval" },
  // A dispatched worker's completion or prompt is not a separate cue for the
  // user. Its unread dot remains; approval and exit still request attention.
  // Nor is the finished turn of an agent another agent manages: its manager
  // follows its work, and the person hears from the manager.
  done: { pref: "agentDone", suppressWhenVisible: true, dispatchedWorkers: false, managedAgents: "managedAgentDone", phone: "done" },
  input: { pref: "agentDone", suppressWhenVisible: true, dispatchedWorkers: false, managedAgents: null, phone: "input" },
  exited: { pref: "agentExited", suppressWhenVisible: true, dispatchedWorkers: true, managedAgents: null, phone: null },
  // `dure notify`: the text is shown nowhere else, so a visible pane does not
  // hide it, and a dispatched worker sent it on purpose. The phone takes it
  // once the push service carries the kind (#721).
  message: { pref: "agentMessage", suppressWhenVisible: false, dispatchedWorkers: true, managedAgents: null, phone: null },
};

/** The agent a notification names, as a receipt reports it. */
export interface AgentNotificationSender {
  id: string;
  name: string;
  project?: string;
}

/** Why a surface was not asked to show the notification at all. */
type NotificationSkip =
  | "no_agent"
  | "not_main_window"
  | "dispatched_worker"
  | "managed_agent"
  | "muted"
  | "rate_limited";

type AgentNotificationDesktopReceipt =
  | { status: "shown" }
  | { status: "disabled" }
  | { status: "permission_denied"; reason: "permission-denied" | "permission-not-requested" }
  | { status: "failed"; reason: string }
  | { status: "not_sent"; reason: NotificationSkip | "visible" | "throttled" };

type AgentNotificationPhoneReceipt =
  /** Handed to the paired Hub's push path, which decides the recipients. */
  | { status: "queued" }
  | { status: "not_sent"; reason: NotificationSkip | "unsupported" | "no_event" };

/** What each surface did with one notification. */
export interface AgentNotificationReceipt {
  agent: AgentNotificationSender | null;
  desktop: AgentNotificationDesktopReceipt;
  phone: AgentNotificationPhoneReceipt;
}

/** A receipt for a notification no surface was asked to show. */
export function skippedAgentNotification(
  agent: AgentNotificationSender | null,
  reason: NotificationSkip,
): AgentNotificationReceipt {
  return {
    agent,
    desktop: { status: "not_sent", reason },
    phone: { status: "not_sent", reason },
  };
}

type StoreAgent = ReturnType<typeof useStore.getState>["agents"][number];

/** The agent a notification names and its title; a command run outside any
 *  agent gets a title that names neither an agent nor the product. */
export function agentNotificationSender(agent: StoreAgent | null): {
  sender: AgentNotificationSender | null;
  title: string;
} {
  if (!agent) return { sender: null, title: t("notifications.agentMessage.personTitle") };
  const project = useStore.getState().projects.find((p) => p.id === agent.projectId);
  const name = agentDisplayName(agent);
  return {
    sender: { id: agent.id, name, ...(project ? { project: project.name } : {}) },
    title: project ? `${name} · ${project.name}` : name,
  };
}

function desktopReceipt(receipt: NotificationDispatchReceipt): AgentNotificationDesktopReceipt {
  if (receipt.accepted) return { status: "shown" };
  if (receipt.reason === "permission-denied" || receipt.reason === "permission-not-requested") {
    return { status: "permission_denied", reason: receipt.reason };
  }
  return { status: "failed", reason: receipt.reason ?? "dispatch-failed" };
}

/** 에피소드 kind → 알림 본문. 순수 함수 — 테스트 대상. The desktop's
 *  turn copy already names both a finished turn and a wait for input. */
export function episodeNotificationBody(kind: AttentionEpisodeKind): string {
  return kind === "approval"
    ? t("agents.attention.approvalNeeded")
    : t("agents.attention.turnFinished");
}

/**
 * The approval a phone alert may answer with Allow once and Deny: the Host's
 * pending request, by its identity, when it offers both answers. Anything
 * else is answered where the person can read it.
 */
function alertApproval(
  runtime: HmuxAgentRuntimeState | undefined,
): { attentionId: string; terminalEpoch: string } | undefined {
  const approval = pendingApproval(runtime);
  if (!runtime || !approval) return undefined;
  const { choices } = approval.request;
  return choices.includes("approve") && choices.includes("deny")
    ? { attentionId: approval.attentionId, terminalEpoch: runtime.terminalEpoch }
    : undefined;
}

/**
 * The process a text reply on a finished turn's phone alert must reach: an
 * Hmux agent idle with nothing raised, as the Host admits a prompt. A
 * chat-owned agent takes its prompts on another path, so none.
 */
function alertReply(
  agent: Parameters<typeof chatOwnedAgent>[0],
  runtime: HmuxAgentRuntimeState | undefined,
): { terminalEpoch: string } | undefined {
  if (chatOwnedAgent(agent) || runtime?.lifecycle !== "running") return undefined;
  return runtime.activity === "waiting" && runtime.attention === "none"
    ? { terminalEpoch: runtime.terminalEpoch }
    : undefined;
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

/** The phone's share of one event. The phone's preference and recipient
 *  authority belong to the paired Hub; desktop visibility and the per-kind
 *  switches apply only to this screen. */
function pushToPhone(
  agent: StoreAgent | null,
  policy: AgentNotificationPolicy,
  eventId: string | undefined,
): AgentNotificationPhoneReceipt {
  if (!agent) return { status: "not_sent", reason: "no_agent" };
  if (!policy.phone) return { status: "not_sent", reason: "unsupported" };
  if (!eventId) return { status: "not_sent", reason: "no_event" };
  const kind = policy.phone;
  const sessionId = agentSeatKey(agent);
  const runtime = useStore.getState().sessionAgentRuntimeState[agent.sessionId];
  const approval = kind === "approval" && sessionId ? alertApproval(runtime) : undefined;
  const reply = kind === "done" && sessionId ? alertReply(agent, runtime) : undefined;
  void pushAgentNotification(
    {
      kind,
      eventId,
      ...(sessionId ? { sessionId } : {}),
      ...(approval ? { approval } : {}),
      ...(reply ? { reply } : {}),
    },
    agent.provider,
  ).catch(() => {
    console.warn("Could not deliver the agent event to paired phone notifications");
  });
  return { status: "queued" };
}

/**
 * One notification for the person, from an agent or, with `agentId` null,
 * from a command run outside any agent. Sent only when it passes the kind's
 * policy, the preferences, visibility suppression and the throttle.
 */
export async function notifyAgentEvent(
  agentId: string | null,
  kind: AgentNotificationKind,
  body: string,
  options?: { eventId?: string },
): Promise<AgentNotificationReceipt> {
  if (!isMainWindow()) return skippedAgentNotification(null, "not_main_window"); // 알림은 메인 창에서만 1회
  const policy = NOTIFICATION_POLICY[kind];
  const agent =
    agentId === null ? null : useStore.getState().agents.find((a) => a.id === agentId);
  if (agent === undefined) return skippedAgentNotification(null, "no_agent");
  const { sender, title } = agentNotificationSender(agent);
  if (agent && !policy.dispatchedWorkers && isDispatchedAgent(agent)) {
    return skippedAgentNotification(sender, "dispatched_worker");
  }
  const np = notifyPrefs();
  // Whether the event is the person's cue at all, decided once for both
  // surfaces: the relation owner's display manager decides, an agent with no
  // known manager tells the person as before, and the person's switch brings
  // the old behavior back on both. Its unread dot stays.
  if (
    agent &&
    policy.managedAgents &&
    !np[policy.managedAgents] &&
    agentRelationsOf(useStore.getState().agents).managerOf(agent.id) !== undefined
  ) {
    return skippedAgentNotification(sender, "managed_agent");
  }
  // The person muted this agent: no desktop alert and no phone push. Its
  // attention episode, unread dot and Needs you entry are not touched.
  if (agent && agentNotificationsMuted(agent)) {
    return skippedAgentNotification(sender, "muted");
  }
  const phone = pushToPhone(agent, policy, options?.eventId);
  if (!np.enabled || !np[policy.pref]) return { agent: sender, desktop: { status: "disabled" }, phone };
  const st = useStore.getState();
  if (agent && policy.suppressWhenVisible && np.suppressWhenVisible) {
    const api = getDockview(st.activeSpaceId);
    const panel = api && findAgentPanel(api, agent.id);
    // AgentPanel의 unread ack와 같은 술어 — 억제와 ack가 어긋나면 알림 없이
    // 보이지 않는 dot만 남는다 (최대화된 다른 그룹 케이스). A pane behind the
    // Work view is not seen either.
    if (isAgentPaneSeen(panel?.api, document.hasFocus())) {
      return { agent: sender, desktop: { status: "not_sent", reason: "visible" }, phone };
    }
  }
  // Host 사건은 native adapter의 bounded exact-id receipt가 중복을 판정한다.
  // 서로 다른 연속 counter를 시간 throttle로 잃지 않도록 legacy에만 적용한다.
  if (!options?.eventId) {
    const now = Date.now();
    const notificationId = `${agentId}:${kind}`;
    if (now - (lastNotified.get(notificationId) ?? 0) < 2_000) {
      return { agent: sender, desktop: { status: "not_sent", reason: "throttled" }, phone };
    }
    lastNotified.set(notificationId, now);
  }
  const paneTarget = agent ? agentPaneTarget(st, agent.id) : undefined;
  const receipt = await systemNotify(title, body, {
    eventId: options?.eventId,
    paneTarget: paneTarget
      ? { ...paneTarget, windowLabel: getCurrentWebviewWindow().label }
      : undefined,
  });
  return { agent: sender, desktop: desktopReceipt(receipt), phone };
}

/** The pane a click on the agent's notification opens. */
function agentPaneTarget(st: ReturnType<typeof useStore.getState>, agentId: string) {
  const mounted = mountedDockviewEntries();
  const candidates = agentPaneLocations(st.layouts, mounted).filter(
    (pane) => pane.agentId === agentId,
  );
  const mountedSpaces = new Set(mounted.map(([desktopId]) => desktopId));
  const mountedCandidates = candidates.filter((pane) => mountedSpaces.has(pane.desktopId));
  return selectNotificationPaneTarget(
    st.activeSpaceId,
    mountedCandidates.length > 0 ? mountedCandidates : candidates,
  );
}

/** 에피소드 → 알림 구독 설치. 메인 창에서 1회 호출한다. 권한 판정과 receipt는
 * native adapter가 소유하고, 부팅 중에는 권한을 요청하지 않는다. */
export function installAgentAttentionNotifier(): () => void {
  return useAgentAttention.subscribe((state, previous) => {
    // Display-only refreshes do not require notification work.
    if (state.episodes === previous.episodes) return;
    for (const agentId of diffEpisodeBumps(previous.episodes, state.episodes)) {
      const kind = state.episodeKinds[agentId] ?? "done";
      void notifyAgentEvent(agentId, kind, episodeNotificationBody(kind), {
        eventId: state.episodeIds[agentId],
      });
    }
  });
}
