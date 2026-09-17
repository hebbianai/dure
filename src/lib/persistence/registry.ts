import { invoke } from "@tauri-apps/api/core";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { normalizeAgentInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { subscribeHmuxControlPlaneCensus } from "@/lib/hmux/identity/hmuxControlPlaneCensusFeed";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { readPublishedAgentRegistry } from "@/lib/ipc/persistence";
import { buildDureClientPresentation } from "@/lib/persistence/dureClientPresentation";
import {
	reconcileExitedManagedAgentCleanupCompensations,
	recoverRemoteManagedAgentCleanupCompensations,
} from "@/lib/sessions/cleanup/exitedManagedAgentCleanupCompensationRuntime";
import { bindingForAgent } from "@/lib/terminal/terminalBinding";
import { subscribeDockviewRegistration } from "@/lib/workspace/dock/dockviewRegistration";
import { useStore } from "@/store";
import type { SshHostConfig } from "@/types";

/** 외부 `dure` CLI가 읽는 레지스트리 스키마. 앱이 store가 바뀔 때마다
 *  ~/.dure/agents.json 에 기록한다. CLI는 이 파일만으로 각 에이전트에
 *  닿는다 — 로컬은 번들 세션 데몬, 원격은 ssh 위 세션 데몬. */
interface RegistryAgent {
  id: string;
  /** Immutable launch/worktree slug used by compatibility lookups. */
  name: string;
  /** Latest IDE-owned label; safe to change without moving resources. */
  displayName: string;
  project: string;
  sessionId: string; // 세션 데몬 세션명
  remoteTmux: string; // 원격 tmux 세션명(sanitized) — ssh 에이전트용
  kind: "pty" | "ssh";
  provider: string;
  worktree: string;
  branch: string;
  ssh: { host: string; port: number; user: string } | null;
	runtimeBinding: ReturnType<typeof bindingForAgent>;
	credentialId: string | null;
	conversationId: string | null;
	interactionProfile: ReturnType<typeof normalizeAgentInteractionProfileV1>;
}

/** `hmux pair`가 읽는 SSH 호스트 목록 — 스토어의 sshHosts를 그대로 비춘 것.
 *  진실의 원본은 여전히 스토어이고, 이 파일은 단방향 투영이다. 앱의 WebKit
 *  localStorage는 다른 프로세스가 안전하게 읽을 수 있는 표면이 아니라서,
 *  agents.json(이미 외부 CLI가 읽는 파일)에 함께 실어 보낸다.
 *
 *  비밀은 싣지 않는다: secretId/password는 OS 자격 증명 저장소에 남는다.
 *  수동 호스트는 명시적 좌표/키 경로를, SSH config 호스트는 폰이 저장할
 *  endpoint 투영과 OpenSSH가 해석할 opaque alias를 함께 담는다.
 *
 *  The SSH host list `hmux pair` reads — a one-way projection of the store's
 *  sshHosts, which remains the single source of truth. The app's WebKit
 *  localStorage is not a surface another process can read safely, so this rides
 *  along in agents.json, which external CLIs already read. No secrets: secretId
 *  and password stay in the OS credential store. Manual rows export explicit
 *  coordinates and a key path; imported rows export the phone's endpoint
 *  projection plus the opaque alias OpenSSH resolves. */
interface RegistrySshHost {
  id: string;
  name: string;
  sshConfigAlias: string | null;
  host: string;
  port: number;
  user: string;
  auth: SshHostConfig["auth"];
  keyPath: string | null;
}

let presentationCache:
  | {
      spaces: ReturnType<typeof useStore.getState>["spaces"];
      layouts: ReturnType<typeof useStore.getState>["layouts"];
      agents: ReturnType<typeof useStore.getState>["agents"];
      projects: ReturnType<typeof useStore.getState>["projects"];
      value: ReturnType<typeof buildDureClientPresentation>;
    }
  | undefined;

function clientPresentation(
  state: ReturnType<typeof useStore.getState>,
  agents: readonly RegistryAgent[],
) {
  if (
    presentationCache?.spaces === state.spaces &&
    presentationCache.layouts === state.layouts &&
    presentationCache.agents === state.agents &&
    presentationCache.projects === state.projects
  ) {
    return presentationCache.value;
  }
  const value = buildDureClientPresentation({
    spaces: state.spaces,
    layouts: state.layouts,
    agents,
  });
  presentationCache = {
    spaces: state.spaces,
    layouts: state.layouts,
    agents: state.agents,
    projects: state.projects,
    value,
  };
  return value;
}

export function buildRegistry() {
  const s = useStore.getState();
  const agents: RegistryAgent[] = s.agents.map((a) => {
    const project = s.projects.find((p) => p.id === a.projectId);
    const host =
      a.sessionKind === "ssh" && project?.sshHostId
        ? s.sshHosts.find((h) => h.id === project.sshHostId)
        : undefined;
    return {
      id: a.id,
      name: a.name,
      displayName: agentDisplayName(a),
      project: project?.name ?? "",
      sessionId: a.sessionId,
      remoteTmux: a.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-"),
      kind: a.sessionKind,
      provider: a.provider,
      worktree: a.worktreePath,
      branch: a.branch,
      ssh: host ? { host: host.host, port: host.port, user: host.user } : null,
			runtimeBinding: bindingForAgent(a, s.projects),
			credentialId: a.credentialId ?? null,
			conversationId: a.conversationId ?? null,
			interactionProfile: normalizeAgentInteractionProfileV1(a.interactionProfile),
    };
  });
  const projects = s.projects.map((p) => {
    const host =
      p.kind === "ssh" && p.sshHostId
        ? s.sshHosts.find((h) => h.id === p.sshHostId)
        : undefined;
    return {
      name: p.name,
      path: p.path,
      kind: p.kind,
      isRepo: p.isRepo,
      ssh: host ? { host: host.host, port: host.port, user: host.user } : null,
    };
  });
  const sshHosts: RegistrySshHost[] = s.sshHosts.map((host) => ({
    id: host.id,
    name: host.name,
    sshConfigAlias: host.sshConfigAlias ?? null,
    host: host.host,
    port: host.port,
    user: host.user,
    auth: host.auth,
    keyPath: host.keyPath ?? null,
  }));
  return {
    version: 3,
    updatedAt: Date.now(),
    clientPresentation: clientPresentation(s, agents),
    sshHosts,
    agents,
    projects,
  };
}

type AgentRegistry = ReturnType<typeof buildRegistry>;

function parseAgentRegistry(raw: string): AgentRegistry | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<AgentRegistry>;
    return Array.isArray(parsed.agents) && Array.isArray(parsed.projects)
      ? (parsed as AgentRegistry)
      : undefined;
  } catch {
    return undefined;
  }
}

function registrySignature(registry: AgentRegistry): string {
  return JSON.stringify([
    registry.agents,
    registry.clientPresentation,
    registry.projects,
    registry.sshHosts,
  ]);
}

let last = "";

/** store 변경 시 레지스트리를 디스크에 반영(내용이 실제로 바뀔 때만). */
export function startRegistrySync() {
  let censusSessions: readonly HmuxSessionSummary[] | undefined;
  let previousPublicationLoaded = false;
  let writeInFlight = false;
  let writeAgain = false;
  let stopped = false;
  const publish = async () => {
    if (stopped || !previousPublicationLoaded) return;
    if (writeInFlight) {
      writeAgain = true;
      return;
    }
    const next = buildRegistry();
    const sig = registrySignature(next);
    if (sig === last) return;
    writeInFlight = true;
    try {
      await invoke("write_agent_registry", {
        json: JSON.stringify(next, null, 2),
      });
      if (stopped) return;
      last = sig;
    } catch (error) {
      console.error(`[agent registry] publication failed: ${String(error)}`);
    } finally {
      writeInFlight = false;
      if (writeAgain && !stopped) {
        writeAgain = false;
        void publish();
      }
    }
  };
  const flush = () => void publish();
  void readPublishedAgentRegistry()
    .then((raw) => {
      const previousPublication = parseAgentRegistry(raw);
      if (previousPublication) last = registrySignature(previousPublication);
    })
    .catch((error) => {
      console.error(`[agent registry] previous publication unavailable: ${String(error)}`);
    })
    .finally(() => {
      previousPublicationLoaded = true;
      flush();
    });
  const stopCensus = subscribeHmuxControlPlaneCensus((census) => {
    censusSessions = census.sessions;
		reconcileExitedManagedAgentCleanupCompensations(census.sessions);
  });
	const stopDockviewRegistration = subscribeDockviewRegistration(() => {
		if (censusSessions) {
			reconcileExitedManagedAgentCleanupCompensations(censusSessions);
		}
		void recoverRemoteManagedAgentCleanupCompensations();
	});
	void recoverRemoteManagedAgentCleanupCompensations();
	const unsubscribe = useStore.subscribe((state, previous) => {
		if (
			state.agents !== previous.agents ||
			state.projects !== previous.projects ||
			state.sshHosts !== previous.sshHosts ||
			state.spaces !== previous.spaces ||
			state.layouts !== previous.layouts
		) {
			flush();
		}
	});
  return () => {
    stopped = true;
    stopCensus();
		stopDockviewRegistration();
    unsubscribe();
  };
}
