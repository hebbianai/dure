// Shared declarations retain the frontend's existing provider type contract.

export type Provider =
  // 앱이 처음부터 다뤄온 세 개 — 대화 재개·계정 분리까지 전부 지원한다.
  | "claude"
  | "codex"
  | "kimi"
  // 추가 provider catalog. 설치돼 있어야 메뉴에 뜨며 capability는 각 spec이 선언한다.
  | "gemini"
  | "cursor"
  | "copilot"
  | "opencode"
  | "amp"
  | "goose"
  | "droid"
  | "auggie"
  | "grok"
  | "hermes"
  | "qwen-code"
  | "cline"
  | "continue"
  | "charm"
  | "codebuff"
  | "kilocode"
  | "kiro"
  | "rovo-dev"
  | "mistral-vibe"
  | "antigravity"
  | "openclaude"
  | "pi"
  | "oh-my-pi"
  | "command-code";

/** Explicit per-session terminal capability overrides.
 * `null` removes a variable; absent keys use the interactive profile. */
export type TerminalEnvironment = Partial<
  Record<
    | "TERM"
    | "COLORTERM"
    | "NO_COLOR"
    | "CLICOLOR"
    | "CLICOLOR_FORCE"
    | "FORCE_COLOR",
    string | null
  >
>;

export interface ProviderSpec {
  label: string;
  /** 새 세션 실행 명령. 설치 감지도 이 명령의 첫 낱말로 한다. */
  cmd: string;
  /** 직전 대화 이어서. 모르면 비워둔다 — 새 세션으로 폴백한다. */
  resumeCmd?: string;
  /** 특정 대화 재개 명령 (대화 목록에서 고를 때). 없으면 대화 전환 미지원. */
  resumeId?: (conversationId: string) => string;
  /** 정확한 대화 picker가 사용할 검증된 목록 adapter. 값은 목록의 권위가
   *  provider-owned local record인지 CLI의 structured output인지 구분한다. */
  conversationList?: "local_records" | "provider_cli";
  /** 대화를 복제해 분기하는 플래그 (claude --fork-session). */
  forkFlag?: string;
  /** 원본과 새 대화 ID를 모두 고정해 provider-native 분기를 시작하는 명령. */
  forkId?: (sourceConversationId: string, newConversationId: string) => string;
  /** Provider가 새 ID를 발급하는 provider-native 분기 명령. */
  forkSource?: (sourceConversationId: string) => string;
  /** 새 worktree에서 원본 대화를 안전하게 분기할 수 있는 검증된 방식. */
  conversationFork?:
    | "copy_and_flag"
    | "native_fork"
    | "native_fork_generated";
  /** 권한 확인/승인 건너뛰기 플래그 (에이전트 설정에서 켤 때 붙음) */
  skipPermFlag?: string;
  /** 계정 로그인 명령 (없으면 cmd를 그냥 실행 — claude처럼 실행 시 로그인하는 CLI) */
  loginCmd?: string;
  /** Login without a browser or localhost callback on the provider host. */
  remoteLoginCmd?: string;
  /** 계정별 설정 디렉터리를 지정하는 환경변수. 있는 프로바이더만 계정 분리·전환을 지원한다. */
  configEnv?: string;
  /** credential root 밖의 canonical 상태를 함께 쓰기 위한 source-owned env assignment. */
  accountSharedStateEnv?: string;
  /** 설정 > 계정 메뉴의 "계정 페이지 열기"가 여는 주소 */
  accountUrl?: string;
  /** 설정 디렉터리 안의 자격증명 파일 — "계정을 이 호스트로 복사"가 이것만 옮긴다.
   *  비어 있으면 복사를 지원하지 않는다(원격에서 직접 로그인해야 함). */
  credentialFiles: string[];
  /** 프로세스 감지용 실행 파일 이름들 — cmd의 첫 낱말 말고도 이 이름으로 잡는다.
   *  (예: rovo-dev는 `acli`로 뜨고, mistral-vibe는 `vibe-acp`로도 돈다) */
  detectNames?: string[];
  /** 모델을 고르는 플래그(예: "--model"). 설정 › 프로바이더가 이 CLI로 무엇을
   *  할 수 있는지 보여줄 때 쓴다 — 앱이 직접 붙이지는 않는다. */
  modelFlag?: string;
  /** 비대화형/1회 실행 모드(예: "-p", "exec", "run"). 위와 같이 표시 전용이다. */
  headlessFlag?: string;
  /** 사용자 설정 파일 경로(예: "~/.claude/settings.json"). 표시 전용. */
  configFile?: string;
  /** MCP 서버를 붙이는 방법 — 서브커맨드이거나 설정 파일 경로다. 표시 전용
   *  (앱이 MCP를 대신 배선하지는 않는다). */
  mcpSetup?: string;
  /** 설정 디렉터리를 바꾸는 환경변수 **이름만** 기록한다. `configEnv`와 일부러
   *  갈라 둔다: `configEnv`는 계정 분리(per-process credential overlay)를 켜는
   *  스위치라, 검증된 어댑터가 없는 provider에 선언하면 앱이 지킬 수 없는 계정
   *  기능을 약속하게 된다. 이 필드는 화면에 알려 줄 뿐 아무 동작도 켜지 않는다. */
  configDirEnv?: string;
  /** src/assets/agent-logos 의 파일명(확장자 제외). 없으면 내장 글리프를 쓴다. */
  logo?: string;
  /** 설치 감지와 무관하게 항상 메뉴에 노출 (앱의 기본 에이전트). */
  core?: boolean;
  /** Explicit Basic rollout approval. Missing approval keeps a provider in Pro.
   * Promote only after recording behavioral qualification on its work issue. */
  basic?: boolean;
  /** Executable discovery alone is ambiguous, so installation requires the
   * provider preflight to report readiness as well. */
  installationProbeRequiresReady?: boolean;
  /** Bundled backend가 `workflow.delegate_once`의 provider/prompt adapter를
   * 제공한다. UI는 이 선언만 보고 위임 후보를 노출하고, 백엔드가 최종 검증한다. */
  workflowDelegate?: boolean;
  /** The bundled backend can continue a native CLI conversation through
   * structured Chat. The UI uses this only for visibility; the backend is
   * still the mutation authority. */
  structuredChat?: boolean;
  short?: string;
}

export const PROVIDERS: Record<Provider, ProviderSpec>;
export const PROVIDER_IDS: Provider[];
