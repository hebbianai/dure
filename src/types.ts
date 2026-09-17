// provider 계약 타입은 타입-leaf로 빠졌다(순환 방지). 기존 임포터를 위해
// 여기서 그대로 다시 내보낸다.
export type {
	Provider,
	ProviderSpec,
	TerminalEnvironment,
} from "@/lib/agents/providerContracts";

import type { AgentCanonicalSpawnV1 } from "@/lib/agents/agentCanonicalSpawn";
import type {
	Provider,
	TerminalEnvironment,
} from "@/lib/agents/providerContracts";
import type { HmuxManagedGenerationV1 } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { DureAgentRuntimeLaunchSelectionV1 } from "@/lib/agents/agentRuntimeLaunchSelectionTypes";

/** provider 매니페스트는 데이터라 자기 모듈에 산다(god-file 라쳇).
 *  기존 임포터(`import { PROVIDERS } from "@/types"`)를 위해 여기서 재-export한다. */
export { PROVIDERS } from "@/lib/agents/providerCatalog";

export type SessionKind = "pty" | "ssh";

/** Exact, non-secret Host projection fence persisted with a managed binding.
 * The provider-native value stays opaque; ordering is decided only by the
 * complete Host fence and decimal u64 revision. */
export interface ProviderConversationIdentityBindingV1
	extends HmuxManagedGenerationV1 {
  schemaVersion: 1;
  sessionId: string;
  workspaceId: string;
  revision: string;
  observedThroughOutputSeq: string;
  providerId: Provider;
  conversationId: string;
  source: "launch_request" | "provider_event";
}

/** Durable non-secret runtime identity for an Agent. Records created before
 * this field existed remain valid and are interpreted from sessionKind. */
export type AgentRuntimeBindingV1 =
  | {
      schemaVersion: 1;
      runtime: "hmux_managed_v1";
      source: "local";
      hostId: "local";
      sessionId: string;
      workspaceId: string;
      /** Stable create operation identity; retries never derive it from a
       * mutable resume command, cwd, or credential selection. */
      createIdempotencyKey?: string;
      /** Non-secret control-plane route for Chat/runtime transitions. */
      backendProfileId?: string;
      /** Exact Host generation captured at create/recovery commit. Missing on
       * legacy records; destructive retries then fail closed after replay. */
      stopFence?: HmuxManagedStopFenceV1;
      /** Non-secret provider credential reference; never auth material. */
      credentialId?: string;
      /** Optional generation of a future serialized global credential pointer. */
      credentialGeneration?: number;
      /** Latest exact Host-owned conversation projection accepted by CAS. */
      conversationIdentity?: ProviderConversationIdentityBindingV1;
    }
  | {
      schemaVersion: 1;
      runtime: "hmux_managed_v1";
      source: "ssh";
      hostId: string;
      sessionId: string;
      workspaceId: string;
      createIdempotencyKey: string;
      /** Receipt projection for the first prompt accepted by this SSH lifetime. */
      initialPromptDigest?: string;
      commandBridgeNonce: string;
      /** Non-secret control-plane route for Chat/runtime transitions. */
      backendProfileId?: string;
      stopFence?: HmuxManagedStopFenceV1;
      /** Non-secret credential profile reference on the remote account. */
      credentialId?: string;
      /** Exact provider-scoped profile directory selected for this generation. */
      credentialProfileDirectory?: string;
      /** Latest exact Host-owned conversation projection accepted by CAS. */
      conversationIdentity?: ProviderConversationIdentityBindingV1;
    }
  | {
      schemaVersion: 1;
      runtime: "hmux_standalone_v1";
      source: "local";
      hostId: "local";
      sessionId: string;
      workspaceId: string;
    };

export type HmuxManagedStopFenceV1 = HmuxManagedGenerationV1;

/** 프로바이더 credential profile.
 * `dir` is supported only by reviewed per-process adapters. Overlay adapters
 * may use it as a thin provider state root (for example Codex CODEX_HOME) while
 * keeping reviewed canonical state outside the profile. */
export interface AccountProfile {
  id: string;
  provider: Provider;
  name: string;
  dir: string;
}

export type AgentActivity = "connecting" | "working" | "waiting" | "exited";

/** Exact ownership proof for one app-created SSH credential account. */
export interface SshCredentialClaimV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly hostId: string;
  readonly registrationGeneration: string;
}

export interface SshHostConfig {
  id: string;
  /** Opaque incarnation for exact destructive consent; absent on legacy rows. */
  registrationGeneration?: string;
  name: string;
  /** Opaque `ssh(1)` destination retained when this host came from SSH config. */
  sshConfigAlias?: string;
  host: string;
  port: number;
  user: string;
  auth: "auto" | "password" | "key";
  /** Generation-owned OS credential store account. */
  credential?: SshCredentialClaimV1;
  /** Read-only compatibility mirror; ownership comes only from `credential`. */
  secretId?: string;
  /** Legacy localStorage migration only; new writes must never set this. */
  password?: string;
  keyPath?: string;
}

/** `~/.ssh/config`에서 읽어온 호스트 — 등록 전이라 id가 없다. */
export interface SshConfigHost {
  alias: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/** 설정 파일 하나 = 사이드바의 폴더 하나. */
interface SshConfigFile {
  path: string;
  displayPath: string;
  hosts: SshConfigHost[];
}

export interface SshConfigScan {
  files: SshConfigFile[];
  /** `User`가 없는 호스트에 쓸 로컬 사용자명. */
  defaultUser: string;
  /** Absent on older backends; partial scans cannot establish alias absence. */
  aliasInspection?: { kind: "complete"; aliases: string[] } | { kind: "partial" };
}

export interface Project {
  id: string;
  name: string;
  path: string;
  kind: "local" | "ssh";
  sshHostId?: string;
  isRepo: boolean;
}

/** Durable, non-secret request to replace one managed provider credential
 * after the exact active Host turn completes. Every source and replacement
 * input needed before the destructive stop boundary is persisted here. */
export interface DeferredCredentialSwitchIntentV1 {
  schemaVersion: 1;
  requestId: string;
  targetCredentialId: string | null;
  targetCredentialDirectory: string | null;
  sourceSessionId: string;
  sourceWorkspaceId: string;
  sourceConversationId: string;
  sourceCredentialId: string | null;
  sourceCreateIdempotencyKey: string | null;
  sourceCredentialGeneration: number | null;
  /** Backend selection to preserve when completing a revisioned account action. */
  sourceSelectionRevision?: number;
  /** Settings and account edits share the same durable replacement boundary. */
  targetLaunchSelection?: DureAgentRuntimeLaunchSelectionV1;
  sourceTerminalEpoch: string;
  baselineRuntimeRevision: string;
  baselineTurnCompletedCount: string;
  /** Exact Host event that proved completion. Persisted before preflight so a
   * reload can distinguish that event from later activity. */
  completionRuntimeRevision?: string;
  completionTurnCompletedCount?: string;
  /** Explicit user authorization to interrupt the current turn. Automatic
   * boundaries are represented only by the exact Host checkpoint above. */
  completionReason?: "user_requested";
  panelId: string;
  requestedAtMs: number;
  lastError?: string;
}

export interface Agent {
  id: string;
  /** Exact backend spawn receipt projected into this client registration.
   * Absence is the explicit legacy/imported/adopted partition. */
  canonicalSpawn?: AgentCanonicalSpawnV1;
  /** Immutable launch/worktree slug. User-visible rename uses displayName. */
  name: string;
  /** IDE-owned label only; never changes worktree, branch, or runtime identity. */
  displayName?: string;
  provider: Provider;
  projectId: string;
  /** cwd of the agent — its dedicated worktree, or the project root */
  worktreePath: string;
  branch: string;
  sessionId: string;
  sessionKind: SessionKind;
  /** Explicit durable runtime. Missing means a backward-compatible legacy
   * pty/ssh record and is never live-adopted into Hmux. */
  runtimeBinding?: AgentRuntimeBindingV1;
  /** Client projection of the backend-owned interaction profile. Absence is
   * the native CLI profile used by existing Terminal panes. */
  interactionProfile?: import("@/lib/agents/chat/agentInteractionProfile").AgentInteractionProfileV1;
  /** Non-secret projection of the backend-owned execution selection. Unlike
   * credentialId, this preserves the exact credential generation required by
   * a journaled runtime replacement. */
  executionProfile?: import("@/lib/agents/chat/agentConversationContract").AgentExecutionProfileV1;
  /** 첫 세션이 이미 시작된 적 있는지 — 재부착 시 resumeCmd 사용 여부 결정 */
  started?: boolean;
  /** 첫 스폰에 한 번만 쓸 명령 오버라이드 (포크 등) — 스폰 후 제거됨 */
  pendingCmd?: string;
  /** 새 프로세스를 만들 때마다 재적용되는 명시적 terminal env override. */
  terminalEnv?: TerminalEnvironment;
  /** 이 pane에서 쓸 계정. undefined면 전역 활성 계정을 따르고,
   *  null이면 "기본 계정(CLI에 로그인된 그대로)"을 명시적으로 고른 것이다. */
  accountId?: string | null;
  /** 권한 확인 건너뛰기(위험 플래그) — undefined면 전역 설정을 따르고,
   *  true/false는 시작 시 명시한 에이전트별 고정값이다. */
  skipPermissions?: boolean;
  /** Non-secret provider credential reference. It never contains auth material.
   * Provider adapters resolve it only immediately before a new process launch. */
  credentialId?: string;
  /** Provider-native conversation identity when explicitly observed/selected.
   * Credential migration must never replace this with a `--last` lookup. */
  conversationId?: string;
  /** 마지막 신원 관측의 결과. 확정 실패를 삼키지 않고 남겨, 계정 전환이 왜
   * 막혔는지 UI가 설명할 수 있게 한다 (hebbian-frontend-qgwg). */
  conversationIdentity?: import("@/lib/sessions/managed/conversationIdentityReadiness").ConversationIdentityReadiness;
  /** Managed-only credential replacement deferred to a Host-proven turn end. */
  pendingCredentialSwitch?: DeferredCredentialSwitchIntentV1;
  /** Backend-owned workflow receipt로 이 pane을 다시 찾기 위한 최소 투영.
   * 상태·결과는 복제하지 않고 exact Dispatch generation만 보존한다. */
  workflowDispatch?: {
    schemaVersion: 1;
    taskId: string;
    dispatchId: string;
    generation: number;
  };
}

/** Canonical persisted identity for one user-arranged pane Space. */
export interface Space {
  id: string;
  name: string;
  /** pane "새 창으로 분리"가 만든 Space. */
  kind?: "popout";
  /** popout 원본 Space. */
  originSpaceId?: string;
  returnLayout?: unknown;
}

/** @deprecated Use `Space`; this is a compatibility view of the same state. */
export interface Desktop extends Space {
  /** @deprecated Use `originSpaceId`. */
  originDesktopId?: string;
}

/** A repo worktree with on-disk evidence of external claude/codex sessions. */
export interface DetectedWorktree {
  path: string;
  branch: string;
  isMain: boolean;
  claudeSessions: number;
  claudeLastTs?: number; // epoch ms
  codexSessions: number;
  codexLastTs?: number;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
}

export type SshState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "closed";
