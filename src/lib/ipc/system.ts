// ipc/system — 시스템·provider 유틸(사용량·클립보드·페어링·CLI 브리지 — 추가 분할 후보).
//
// ipc.ts 도메인 분할 1단계(2026-08-01): 내용은 구 src/lib/ipc.ts에서 그대로
// 옮겨졌고, 소비자는 barrel(src/lib/ipc.ts)을 통해 기존 경로를 유지한다.
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).

import { invoke } from "@tauri-apps/api/core";
import type { HubFileDiffReply, RemoteFileDiff } from "@/lib/hub/fileDiffBridge";
import type { HubGitStatusReply, RemoteGitStatus } from "@/lib/hub/gitStatusBridge";
import type { AgentKind, LaunchTarget } from "@/lib/hub/launchOfferWire";
import type { HubSessionFileReply } from "@/lib/hub/sessionFileBridge";
import type { SidebarLayout } from "@/lib/hub/sidebarLayout";
import type { HubStartAgentReply } from "@/lib/hub/startAgentBridge";
import type { ProvStats } from "@/lib/usage/providerStats";
import { createRecentUsageClient } from "@/lib/usage/recentUsageClient";
import type { Provider } from "@/types";
import type { ClaudeCollectorState } from "./diffReview";
import type { SshConnectOpts } from "./sessions";

export const routeSessionFiles = (request: {
	sessionId: string;
	workspaceId: string;
	terminalEpoch: string;
	paths: string[];
	opts?: SshConnectOpts;
}) => invoke<string[]>("route_session_files", request);

/** 이 워크스페이스를 Codex 신뢰 목록에 넣는다(이미 있으면 false).
 *  세션 시작 전에 해둬야 첫 화면 trust modal이 뜨지 않는다 — modal이 떠 있으면
 *  보낸 텍스트는 버려지고 Enter는 modal이 먹는다 (hebbian-frontend-onzg). */

export const codexTrustWorkspace = (path: string) =>
	invoke<boolean>("codex_trust_workspace", { path });

/** provider별 배선 상태 — 읽기 전용 프로브(백엔드가 mutate-to-probe 금지 계약). */
export interface CodexOverlayWiring {
	notifyMerged: boolean;
	trustRekeyed: boolean;
}

export interface ProviderWiringStatus {
	claude: { managedHooksPublished: boolean };
	codex: { notifyPublished: boolean; overlay: CodexOverlayWiring | null };
}

export const providerWiringStatus = (codexAccountDir?: string) =>
	invoke<ProviderWiringStatus>("provider_wiring_status", {
		codexAccountDir: codexAccountDir ?? null,
	});

export interface DureCliIdentity {
	version: string;
	digest: string;
	installRoot: string;
	executablePath?: string;
}

export interface DureCliInstallStatus {
	state: "current" | "outdated" | "missing";
	installed: DureCliIdentity | null;
	available: DureCliIdentity;
}

/** Read the verified CLI installation owned by the active app channel. */
export const dureCliInstallStatus = () =>
	invoke<DureCliInstallStatus>("dure_cli_install_status");

export const installDureCli = () => invoke<void>("install_dure_cli");

/** Match the Windows caption (including its system buttons) to the webview's
 * app-floor colours. The native command is a no-op on other platforms. */
export const setNativeTitleBarColors = (background: string, foreground: string) =>
	invoke<void>("set_native_title_bar_colors", { background, foreground });

export const setAppQuitConfirmationCopy = (copy: Record<string, string>) =>
	invoke<void>("set_app_quit_confirmation_copy", { copy });

/** 배선 행이 가리키는 실제 파일의 raw 내용 — 종류는 백엔드 enum이 게이트하고
 *  Bearer 토큰은 서버측에서 마스킹된다. */
export type ProviderWiringFileKind =
	| "claudeManagedSettings"
	| "codexNotifyScript"
	| "codexOverlayConfig"
	| "codexCanonicalConfig"
	| "codexCanonicalHooks";

export interface ProviderWiringFile {
	path: string;
	content: string;
	truncated: boolean;
}

export const providerWiringFile = (
	kind: ProviderWiringFileKind,
	codexAccountDir?: string,
) =>
	invoke<ProviderWiringFile>("provider_wiring_file", {
		kind,
		codexAccountDir: codexAccountDir ?? null,
	});

export const claudeCollectorInstall = () =>
	invoke<ClaudeCollectorState>("claude_collector_install");

/** 로그인 credential의 표시용 정체성 — 토큰 값은 백엔드가 절대 돌려주지 않는다. */
export interface AccountLoginIdentity {
	status: "authenticated" | "unauthenticated" | "unknown";
	email: string | null;
	plan: string | null;
}

/** dir 미지정(또는 빈 문자열) = 시스템 기본 로그인(canonical 홈). */
export const accountLoginIdentity = (provider: Provider, dir?: string) =>
	invoke<AccountLoginIdentity>("account_login_identity", { provider, dir });

export interface CodexUsageProfileInput {
	credentialId: string | null;
	directory: string | null;
}

export interface CodexPolledRateLimit {
	limitId: string;
	limitName: string | null;
	usedPercent: number | null;
	usedPercentWeekly: number | null;
	resetsAt: number | null;
	weeklyResetsAt: number | null;
	/** Optional for snapshots collected before credit reporting was supported. */
	credits?: {
		hasCredits: boolean;
		unlimited: boolean;
		balance: string | null;
	} | null;
}

export interface CodexUsageSnapshot {
	credentialId: string | null;
	capturedAt: number | null;
	attemptedAt: number | null;
	error: string | null;
	rateLimits: CodexPolledRateLimit[];
	/** Earned usage-limit resets; absent when the service has not reported them. */
	rateLimitResetsAvailable?: number | null;
}

/** 등록된 Codex credential catalog를 backend 수집기에 동기화한다. 토큰이나
 * auth 내용은 넘기지 않으며, backend가 profile 경로를 다시 검증한다. */
export const codexUsageProfilesSync = (profiles: CodexUsageProfileInput[]) =>
	invoke<void>("codex_usage_profiles_sync", { profiles });

export interface UsageRecentReport {
	claude: import("@/lib/usage/usageMeter").ProviderUsage;
	codex: import("@/lib/usage/usageMeter").ProviderUsage;
	/** 계정별 Claude 실측 한도 — 토큰은 계정 공유 저장소라 분해 불가. */
	claudeAccounts: import("@/lib/usage/usageAccounts").ClaudeAccountRateLimit[];
	/** 계정별 Codex 사용량 + 미분류 묶음. */
	codexAccounts: import("@/lib/usage/usageAccounts").CodexAccountUsage[];
	/** 사용 여부와 무관하게 주기 수집한 credential별 마지막 성공 snapshot. */
	codexAccountSnapshots?: CodexUsageSnapshot[];
}

interface UsageScanTelemetry {
	snapshotCacheHits: number;
	cacheHits: number;
	incrementalHits: number;
	fullScans: number;
	bytesRead: number;
	scanDurationMs: number;
	coalescedRequests: number;
}

interface UsageRecentSnapshot {
	fiveHours: UsageRecentReport;
	twentyFourHours: UsageRecentReport;
	telemetry: UsageScanTelemetry;
}

const recentUsageClient = createRecentUsageClient<
	UsageRecentReport,
	UsageScanTelemetry
>((refresh) => invoke<UsageRecentSnapshot>("usage_recent_snapshot", { refresh }));

/** 5시간/24시간 사용량을 한 backend snapshot으로 공유한다. 느린 refresh가
 * 2분 poll을 넘겨도 다음 호출은 같은 in-flight 작업에 합류한다. */
export const usageRecent = (hours: number) => recentUsageClient.get(hours);

export const usageRefresh = (provider: "codex" | "claude") =>
	recentUsageClient.refresh(provider);

/** 최근 N일 세션·턴·일별 통계 (설정 > 통계 및 사용량) — src-tauri usage_stats.
 *  스캔하는 공급자는 Rust 쪽이 정한다 (lib/usageScope.SCANNABLE_PROVIDERS). */
export const usageStats = (days: number) =>
	invoke<UsageStatsReport>("usage_stats", { days });

export interface UsageStatsReport {
	claude: ProvStats;
	codex: ProvStats;
}

/** Non-secret, durable credential eras for provider-native conversations.
 * `credentialId=null` is an explicitly recorded use of the provider's default
 * login; an absent conversation is never guessed into this list. Results are
 * ordered by the durable commit sequence, which stays authoritative if the
 * wall clock moves backwards. */
export interface CredentialConversationBinding {
	schemaVersion: 1;
	launchId: string;
	sessionId: string;
	workspaceId: string;
	providerId: Provider;
	credentialId: string | null;
	conversationId: string;
	effectiveAtMs: number;
	effectiveSequence: number;
}

export const credentialSessionBindings = (providerId: Provider) =>
	invoke<CredentialConversationBinding[]>("credential_session_bindings", {
		providerId,
	});

/** 사용자가 미리 검토한 bounded/redacted 오류 보고서만 로컬 JSON으로 저장한다. */
export const saveErrorReportBundle = (
	path: string,
	bundle: import("@/lib/platform/errorIncident").ErrorReportBundleV1,
) => invoke<void>("save_error_report_bundle", { path, bundle });

export interface ClipboardImageBytes {
	dataB64: string;
	ext: string;
}

export const readClipboardImage = () =>
	invoke<ClipboardImageBytes | null>("read_clipboard_image");

export const saveTempImage = (image: ClipboardImageBytes) =>
	invoke<string>("save_temp_image", {
		dataB64: image.dataB64,
		ext: image.ext,
	});

export interface DroppedFilePayload {
	fileName: string;
	dataB64: string;
}

export const saveTempFile = ({ dataB64, fileName }: DroppedFilePayload) =>
	invoke<string>("save_temp_file", { dataB64, fileName });

export const saveTempFiles = (files: DroppedFilePayload[]) =>
	invoke<string[]>("save_temp_files", { files });

export const saveFilesToDirectory = (
	directory: string,
	files: DroppedFilePayload[],
) => invoke<string[]>("save_files_to_directory", { directory, files });

export const uploadSshFilesToDirectory = (
	opts: SshConnectOpts,
	directory: string,
	files: DroppedFilePayload[],
) =>
	invoke<string[]>("ssh_upload_files_to_directory", { opts, directory, files });

/** Terminal file drop: uploads to a fresh private directory on the remote host
 *  over one connection and returns the absolute paths there. Unlike
 *  `uploadSshFilesToDirectory` the caller names no destination, so nothing the
 *  user already has can be overwritten. */
export const uploadSshFilesToTempDirectory = (
	opts: SshConnectOpts,
	files: DroppedFilePayload[],
) => invoke<string[]>("ssh_upload_files_to_temp_directory", { opts, files });

/** Persists quick-dispatch attachments under `<app_root>/quick-dispatch/<intentId>/`
 *  before the intent record is journaled; returns absolute saved paths. */
export const saveQuickDispatchAttachments = (
	intentId: string,
	files: DroppedFilePayload[],
) => invoke<string[]>("save_quick_dispatch_attachments", { intentId, files });

/** Persists chat-composer attachments under
 *  `<app_root>/chat-attachments/<interactionSessionId>/`; returns absolute
 *  saved paths for the message to reference. */
export const saveChatAttachments = (
	interactionSessionId: string,
	files: DroppedFilePayload[],
) => invoke<string[]>("save_chat_attachments", { interactionSessionId, files });

/** Reads back one saved chat attachment for timeline rendering. The backend
 *  resolves only inside the chat-attachments root and only image types. */
export const readChatAttachment = (path: string) =>
	invoke<{ mime: string; dataB64: string }>("read_chat_attachment", { path });

// ── 모바일 페어링 (설정 → 모바일) ────────────────────────────────────────
//
// `hmux pair start`를 사이드카로 띄우고 그 QR 페이로드를 받아 온다. 페어링
// 규칙 자체는 CLI에 있고 이쪽은 옮기기만 한다 — 같은 규칙을 두 곳에 두었다가
// Tailscale 호스트에서만 터지는 버그를 이미 한 번 겪었다(src-tauri의
// `mobile_pairing` 모듈 주석).

/** 이 기계가 광고할 수 있는 주소 하나. */
export interface NetworkChoice {
	address: string;
	/** `en0`, `utun1` 같은 인터페이스 이름. */
	interface: string;
	/** 100.64.0.0/10 안인지 — 테일넷 주소로 보이는지. */
	tailnet: boolean;
}

/** 페어링이 시작됐고 QR을 그릴 수 있다. 프로세스는 폰을 기다리며 살아 있다. */
export interface PairingStarted {
	payload: string;
	address: string;
	port: number;
	ttl_seconds: number;
}

/** 페어링이 끝났다. `detail`은 CLI가 남긴 문장 그대로다. */
export interface PairingFinished {
	ok: boolean;
	detail: string;
}

/** QR 한 장. 그리는 것은 화면이 한다 — 크기와 여백을 테마가 정하게. */
export interface QrMatrix {
	size: number;
	/** 행 우선, `true`가 어두운 모듈. 길이는 `size * size`. */
	modules: boolean[];
}

export const mobilePairingNetworks = () =>
	invoke<NetworkChoice[]>("mobile_pairing_networks");

export const mobilePairingStart = (
	address: string,
	port: number,
	ttlSeconds: number,
	inventory?: string,
) =>
	invoke<PairingStarted>("mobile_pairing_start", {
		request: {
			address,
			port,
			ttlSeconds,
			inventory: inventory ?? null,
			remoteOnly: false,
		},
	});

export const mobilePairingStop = () => invoke<void>("mobile_pairing_stop");

export const mobilePairingQr = (payload: string) =>
	invoke<QrMatrix>("mobile_pairing_qr", { payload });

// ── macOS 권한 (설정 → macOS) ────────────────────────────────────────────
//
// `SettingsDialog.tsx` 안에 있을 때는 `invoke`를 직접 불렀다. 그 파일이 이미
// baseline에 등재돼 있어 규칙이 새 호출을 막지 못했을 뿐, 규칙을 지키던 것은
// 아니다. 페이지를 별도 파일로 빼면서 드러났고, 여기로 옮긴다.

/** 세 권한의 현재 상태. `null`은 확인하지 못했다는 뜻이다. */
export interface MacosPermissions {
	accessibility: boolean | null;
	screen_recording: boolean | null;
	full_disk: boolean | null;
	/** 아직 물어보지 않은 상태(notDetermined)는 null — "거부됨"과 구분한다. */
	microphone: boolean | null;
	camera: boolean | null;
	bluetooth: boolean | null;
}

export const macosPermissions = () =>
	invoke<MacosPermissions>("macos_permissions");

/** 이 기기에 설치된 글꼴 가족.
 *
 *  monospaced는 더 이상 설정의 글꼴 목록 순서를 바꾸지 않는다(한 목록으로
 *  둔다). 남은 소비자는 부팅 스모크가 고정폭 글꼴을 몇 개 찾았는지 적는
 *  qaSmoke뿐이다. */
export interface FontFamily {
	name: string;
	monospaced: boolean;
}
export const systemFontFamilies = () =>
	invoke<FontFamily[]>("system_font_families");

/** dialog 플러그인 도달 확인 — UI를 열지 않는다. 없는 하위 명령을 불러
 *  "not found"(도달함)와 "not allowed"(권한 없음)를 구분한다. */
export const dialogPluginProbe = async (): Promise<string> => {
	try {
		await invoke("plugin:dialog|__qa_probe__");
		return "unexpected-ok";
	} catch (error) {
		return String(error);
	}
};

/** 상태를 조회할 수 없는 권한(자동화·로컬 네트워크)의 TCC 프롬프트를 유도한다.
 *  성공이 곧 권한 허용을 뜻하지는 않는다 — "요청을 시도했다"까지가 보장이다. */
export const requestPrivacyPrompt = (kind: "automation" | "local_network") =>
	invoke<void>("request_privacy_prompt", { kind });

/** 시스템 설정의 해당 개인정보 보호 창을 연다. */
export const openPrivacyPane = (pane: string) =>
	invoke<void>("open_privacy_pane", { pane });

// ── 원격 로그인 자세 (설정 → 모바일) ────────────────────────────────────
//
// 허브 구조에서 폰은 노트북에 SSH 로 붙는다. 꺼져 있으면 페어링이 "호스트 키가
// 없습니다" 로 실패하는데, 그 문장만으로는 무엇을 켜야 하는지 알 수 없다.

/** 이 기계가 폰의 SSH 를 받을 준비가 됐는지, 어떤 자세로 받는지. */
export interface RemoteLoginPosture {
	/** `null` 은 확인하지 못했다는 뜻이다 — `false` 와 구별해서 말해야 한다. */
	running: boolean | null;
	has_host_key: boolean;
	/** 폰이 QR 로 받아 고정하는 그 지문. */
	host_key_fingerprint: string | null;
	/**
	 * 비밀번호 인증이 열려 있는지. 폰 키의 강제 명령과 **별개의 문**이다 —
	 * 켜져 있으면 계정 비밀번호로 셸이 열린다.
	 */
	password_authentication: boolean | null;
	firewall_enabled: boolean | null;
}

export const remoteLoginPosture = () =>
	invoke<RemoteLoginPosture>("remote_login_posture");

/** 시스템 설정의 공유 창을 연다. 앱이 켜 주지는 않는다. */
export const openSharingSettings = () => invoke<void>("open_sharing_settings");

// ── 폰 허브 ────────────────────────────────────────────────────────────
//
// SSH 페어링(위)과 다른 경로다. 이쪽은 앱이 직접 리스너를 띄우므로 사용자가
// 시스템 원격 로그인을 켤 필요가 없다. 둘은 공존한다 — 앱이 꺼져 있을 때
// 닿아야 하는 경로는 여전히 SSH다. `src-tauri/src/hub/mod.rs` 참조.

export interface HubStatus {
	running: boolean;
	/** 실제로 바인딩된 주소. 요청 포트가 0이면 OS가 고른 값이 온다. */
	address: string | null;
	port: number | null;
	/** 폰이 고정할 인증서 지문. */
	fingerprint: string | null;
	/** 개수만. 이름은 기기 목록이 따로 답한다. */
	device_count: number;
}

export interface PairedDevice {
	device_id: string;
	label: string;
}

export interface HubDeviceRevokeFailure {
	name: string;
	failure: string;
}

export interface HubDeviceRevokeOutcome {
	revoked: boolean;
	failures: HubDeviceRevokeFailure[];
}

/** 허브를 켠다. 포트 0이면 OS가 빈 포트를 고른다. */
/**
 * 켜 두었던 허브를 다시 켠다.
 *
 * 아무것도 새로 열지 않는다 — 사람이 이미 켰고 끄지 않은 것만 돌려놓는다.
 * 기록이 없으면 아무 일도 없이 현재 상태를 돌려준다.
 */
export const hubResume = () => invoke<HubStatus>("hub_resume");

export const hubStart = (address: string, port: number) =>
	invoke<HubStatus>("hub_start", { address, port });

export const hubStop = () => invoke<void>("hub_stop");

export const hubStatus = () => invoke<HubStatus>("hub_status");

export const hubDevices = () => invoke<PairedDevice[]>("hub_devices");

/**
 * 기기 하나를 지운다. 그 기기는 다음 연결부터 거부된다.
 *
 * 이미 붙어 있는 연결까지 끊지는 않는다 — 인증은 붙을 때 한 번 일어난다.
 * 확실히 끊으려면 허브를 껐다 켠다.
 */
export const hubDeviceRevoke = (deviceId: string, forgetUnreachable = false) =>
	invoke<HubDeviceRevokeOutcome>("hub_device_revoke", { deviceId, forgetUnreachable });

export interface PairingOffer {
	/** QR로 그릴 문자열. `dure-hub:3?o=…` */
	payload: string;
	device_id: string;
}

/**
 * 기기를 하나 등록하고 그 기기 전용 QR 페이로드를 받는다.
 *
 * 부를 때마다 **새 기기가 등록된다.** 폰 하나에 하나씩이고, 취소도 기기 단위다.
 */
export const hubPairingOffer = (
	deviceLabel: string,
	advertisedAddress: string,
	relayEndpoint: string,
) =>
	invoke<PairingOffer>("hub_pairing_offer", {
		deviceLabel,
		advertisedAddress,
		relayEndpoint,
	});

/**
 * 사이드바 묶음을 허브에게 알린다.
 *
 * 데스크탑("Workspace", "Onchain")은 **사용자가 이 앱에서 만든 것**이고 hmux 는
 * 그것을 모른다. 폰이 사이드바와 같은 모양으로 그리려면 이 앱이 말해 줘야 한다.
 * 만드는 쪽은 `lib/hub/sidebarLayout.ts`, 받는 쪽은 `hub/layout.rs`.
 *
 * 통째로 갈아 끼운다. 합치면 사이드바에서 지운 세션을 폰에서 지울 방법이 없다.
 */
export const hubSetSidebarLayout = (layout: SidebarLayout) =>
	invoke<void>("hub_set_sidebar_layout", { layout });

/**
 * 폰이 "새 에이전트" 폼을 채울 수 있게 자리와 종류를 알린다.
 *
 * 사이드바 묶음과 달리 목록에 얹히지 않는다. 이 표로 할 수 있는 일은 노트북에게
 * 무언가를 띄워 달라고 하는 것뿐이고, 그건 노트북이 켜져 있어야만 되는 일이라
 * 꺼진 노트북의 폴더 목록을 폰이 들고 있어 봐야 누를 수 없는 화면만 남는다.
 * 만드는 쪽은 `lib/hub/launchOffer.ts`, 받는 쪽은 `hub/start_agent.rs`.
 */
export const hubPublishLaunchOffer = (targets: LaunchTarget[], kinds: AgentKind[]) =>
	invoke<void>("hub_publish_launch_offer", { targets, kinds });

/**
 * 폰이 눌러 달라고 한 것의 결과를, 기다리고 있는 왕복에 돌려준다.
 *
 * 모르는 `requestId` 는 거짓을 돌려준다. 마감을 넘긴 왕복이 정상적으로 그렇게
 * 되고, 그것은 화면의 잘못이 아니다 — 그때 폰은 "떴는지 모른다" 를 보고 목록을
 * 확인하러 간다.
 */
export const hubStartAgentResult = (requestId: string, result: HubStartAgentReply) =>
	invoke<boolean>("hub_start_agent_result", { requestId, result });

/**
 * 폰이 물은 "이 세션이 뭘 바꿨나" 에 대한 답.
 *
 * 인자 하나로 받는다. 여섯 개를 늘어놓으면 `ahead`/`behind` 와
 * `baseRef`/`detail` 이 서로 같은 타입이라, 바꿔 넣어도 타입 검사를 통과하고
 * 폰에는 2 앞선 브랜치가 "0 ahead, 2 behind" 로 뜬다.
 *
 * `detail` 이 있으면 거절이고, 그 문장이 폰 화면에 그대로 나간다. 이진 파일에는
 * `added`/`deleted` 가 없다 — 0 이 아니라 **모르는** 값이라서 아예 빠진다.
 */
/**
 * 원격 상자에 소스 컨트롤을 묻는다.
 *
 * 상자는 `boxId` 하나로 고른다 — 그 id 는 이 창이 스스로 내려보낸 배치표에
 * 있는 것이고, 호스트도 열쇠도 백엔드가 갖는다. 실패는 던진다: 부르는 쪽이
 * 그것을 "그 컴퓨터에 직접 물어라" 로 되돌려야 하기 때문이다.
 */
export const hubRemoteGitStatus = (
	boxId: string,
	sessionId: string,
	workspaceId: string,
	want: "changes" | "commits" | "pull_request" | "branches" | "reviewers" | undefined,
) =>
	invoke<RemoteGitStatus>("hub_remote_git_status", {
		boxId,
		sessionId,
		workspaceId,
		want: want ?? null,
	});

export const hubGitStatusResult = (
	requestId: string,
	reply: HubGitStatusReply,
) =>
	invoke<boolean>("hub_git_status_result", {
		requestId,
		reply,
	});

/**
 * 원격 상자에 파일 하나의 패치를 묻는다.
 *
 * [`hubRemoteGitStatus`] 와 같은 이유로 백엔드를 거친다 — 열쇠도 호스트도
 * 저쪽에 있다. 다른 것은 경로 하나가 실린다는 점이고, 그것을 거르는 자리는
 * 여기가 아니라 저장소 옆(상자의 게이트웨이)이다.
 */
export const hubRemoteFileDiff = (
	boxId: string,
	sessionId: string,
	workspaceId: string,
	path: string,
	commit: string | undefined,
) =>
	invoke<RemoteFileDiff>("hub_remote_file_diff", {
		boxId,
		sessionId,
		workspaceId,
		path,
		commit: commit ?? null,
	});

export const hubSessionFileResult = (
	requestId: string,
	reply: HubSessionFileReply,
) => invoke<boolean>("hub_session_file_result", { requestId, reply });

export const hubFileDiffResult = (requestId: string, reply: HubFileDiffReply) =>
	invoke<boolean>("hub_file_diff_result", {
		requestId,
		reply,
	});

// ── 릴레이: 같은 와이파이 밖에서 닿는 길 ────────────────────────────────
//
// `crates/dure-relay/src/lib.rs`. 허브 직결과 공존한다 — 폰은 직결을
// 먼저 시도하고 실패해야 릴레이로 간다.

export interface RelayStatus {
	/** 다이얼 루프가 돌고 있는가. */
	running: boolean;
	/**
	 * 릴레이가 이 기계를 아는가.
	 *
	 * `running`과 **다른 사실이다.** 스위치는 켜졌지만 아직(또는 영영) 등록되지
	 * 않은 상태가 있고, 그때 폰은 밖에서 못 붙는다. 둘을 한 불로 그리면
	 * 사용자는 왜 안 되는지 알 수 없다.
	 */
	registered: boolean;
	endpoint: string | null;
	server_id: string | null;
	/** 마지막 실패 이유. 등록되면 지워진다. */
	detail: string | null;
}

/** 릴레이에 등록한다. **허브가 먼저 켜져 있어야 한다.** */
export const hubRelayStart = (endpoint: string) =>
	invoke<RelayStatus>("hub_relay_start", { endpoint });

export const hubRelayStop = () => invoke<void>("hub_relay_stop");

export const hubRelayStatus = () => invoke<RelayStatus>("hub_relay_status");

// ── 인증된 로컬 CLI request broker ──────────────────────────────────────

export const cliRequestClaim = (reqId: string) =>
	invoke<boolean>("cli_request_claim", { reqId });

export const cliRequestBeginDecision = (reqId: string) =>
	invoke<number | null>("cli_request_begin_decision", { reqId });

export const cliRequestComplete = (reqId: string, result: unknown) =>
	invoke<void>("cli_request_complete", { reqId, result });

// ── 셸 창 모서리 ────────────────────────────────────────────────────────

/**
 * 셸 유리(NSVisualEffectView)의 네이티브 속성을 앱 상태에 맞춘다.
 *
 * - `radius`: 전체화면 0, 창 모드 SHELL_CORNER_RADIUS.
 * - `dark`: 유리 material의 외형. 창 NSAppearance만 맞추면 이 뷰까지 전파되지
 *   않는 경우가 있어 직접 박는다 — 어긋나면 다크 UI 뒤에 라이트 material이
 *   깔려 사이드바가 통째로 밝게 씻긴다.
 *
 * Tauri의 setEffects로는 못 한다 — window-vibrancy가 호출할 때마다 effect 뷰를
 * 새로 붙이기만 하고 옛 뷰를 지우지 않으며, clearEffects는 macOS 분기가 없다.
 * 그래서 이미 붙어 있는 뷰의 속성만 네이티브에서 직접 바꾼다.
 */
export const setShellGlass = (radius: number, dark: boolean) =>
	invoke<void>("set_shell_glass", { radius, dark });

/** macOS 신호등 중심을 창 위에서 `center`px, 왼쪽에서 `left`px 지점에 놓는다
 *  (각각 0 이하면 그 축은 손대지 않음). */
export const setTrafficLightDrop = (center: number, left: number) =>
	invoke<void>("set_traffic_light_drop", { center, left });

/** On macOS, resolves after the native maximize or restore animation completes. */
export const toggleWindowMaximizeAtomic = () =>
	invoke<void>("toggle_window_maximize_atomic");

/** Installs exact AppKit live-resize boundaries and returns the current phase. */
export const observeCurrentWindowLiveResize = () =>
	invoke<boolean>("observe_current_window_live_resize");
