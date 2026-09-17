import {
	assertCredentialMigrationSupported,
	ProviderCredentialUnsupportedError,
	providerCredentialCapability,
	providerSupportsAccountProfiles,
} from "@/lib/agents/providerCredentials";
import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import {
	PROVIDER_IDS,
	PROVIDERS,
} from "@/lib/agents/providerCatalog";
import { shellQuote } from "@/lib/platform/shell";
import { useStore } from "@/store";
import type { AccountProfile, Agent, Provider, ProviderSpec } from "@/types";

export { PROVIDER_IDS };

export {
	ProviderCredentialUnsupportedError,
	providerCredentialCapability,
	providerSupportsAccountProfiles,
} from "@/lib/agents/providerCredentials";
export {
	providerFromCommand,
	providerFromLegacyLaunchCommand,
} from "@/lib/agents/providerIdentity";

function spec(provider: Provider): ProviderSpec {
  return PROVIDERS[provider];
}

/** 계정 분리를 지원하는 프로바이더 — 검증된 per-process adapter(alias 또는
 *  overlay)가 있는 것만. */
export function supportsAccounts(provider: Provider): boolean {
	return providerSupportsAccountProfiles(provider);
}

export function supportsStructuredChat(provider: Provider): boolean {
	return spec(provider).structuredChat === true;
}

/** 계정 UI(추가·전환·로그인)에 노출할 프로바이더. */
export function accountProviders(): Provider[] {
  return PROVIDER_IDS.filter(supportsAccounts);
}

/** 활성 계정 프로필 (없으면 기본 계정 = 프로필 미지정) */
export function activeAccount(provider: Provider): AccountProfile | undefined {
	if (!supportsAccounts(provider)) return undefined;
  const st = useStore.getState();
  const id = st.activeAccounts[provider];
  return st.accounts.find((a) => a.id === id && a.provider === provider);
}

/** Resolve the account committed to an Agent runtime. Runtime-owned profile or
 * binding facts never fall back to a later global selection; only unlaunched
 * legacy records without runtime authority inherit the provider default. */
export function agentAccount(
  agent: Pick<
    Agent,
    | "provider"
    | "executionProfile"
    | "interactionProfile"
    | "runtimeBinding"
    | "accountId"
    | "credentialId"
  >,
): AccountProfile | undefined {
  if (!supportsAccounts(agent.provider)) {
    if (agentCredentialReferenceId(agent)) {
      throw new ProviderCredentialUnsupportedError(agent.provider);
    }
    return undefined;
  }
	const referenceId = agentCredentialReferenceId(agent);
	if (referenceId) {
		return useStore
			.getState()
			.accounts.find(
				(account) =>
					account.id === referenceId && account.provider === agent.provider,
			);
	}
  if (
    agent.executionProfile !== undefined ||
    agent.interactionProfile !== undefined ||
    agent.runtimeBinding?.runtime === "hmux_managed_v1" ||
    agent.accountId === null
  ) {
    return undefined;
  }
  if (agent.accountId === undefined) return activeAccount(agent.provider);
  return useStore
    .getState()
    .accounts.find((a) => a.id === agent.accountId && a.provider === agent.provider,
		);
}

/** Provider-scoped account-directory leaf shared by backend registration and
 * remote provisioning. This never exposes or accepts the absolute path. */
export function providerAccountDirectoryName(account: AccountProfile): string {
  const slug = account.dir.split("/").filter(Boolean).pop() ?? account.provider;
  if (
    !slug.startsWith(`${account.provider}-`) ||
    !/^[A-Za-z0-9_-]+$/.test(slug)
  ) {
    throw new Error(
      "remote_credential_directory_untrusted: account profile has an unsafe provider slug",
    );
  }
  return slug;
}

export function remoteAccountDir(account: AccountProfile): string {
  return `.dure/accounts/${providerAccountDirectoryName(account)}`;
}

/** 원격 명령 앞에 붙일 계정 env. Profile provisioning is a separate
 * backend preflight and must complete before this command is launched. */
function remoteAccountPrefix(
	provider: Provider,
	account?: AccountProfile,
): string {
  const providerSpec = spec(provider);
  const env = providerSpec.configEnv;
  if (!account || !env) return "";
  const base = `$HOME/${remoteAccountDir(account)}`;
  const dir = `"${base}"`;
  if (
    providerCredentialCapability(provider).credentialSelection ===
    "per_process_credential_overlay"
  ) {
    const sharedState = providerSpec.accountSharedStateEnv
      ? ` ${providerSpec.accountSharedStateEnv}`
      : "";
    return `env ${env}=${dir}${sharedState} `;
  }
  return `mkdir -p ${dir} && ${env}=${dir} `;
}

/** 로컬 계정 env 프리픽스 — 계정 디렉터리를 절대경로로 지정한다. */
function localAccountPrefix(
	provider: Provider,
	account?: AccountProfile,
): string {
  const providerSpec = spec(provider);
  const env = providerSpec.configEnv;
	// `env` keeps the launch executable after this prefix, so the managed Host's
	// login shell can safely `exec` the complete command without treating an
	// assignment word as the executable name.
	if (!account || !env) return "";
	const profileRoot = shellQuote(account.dir);
	const sharedState = providerSpec.accountSharedStateEnv
		? ` ${providerSpec.accountSharedStateEnv}`
		: "";
	return `env ${env}=${profileRoot}${sharedState} `;
}

// 참고: 계정 미지원 프로바이더에 명시적 계정을 지정하는 시도는 agentAccount가
// fail-closed로 거부한다. 명령 조립부는 configEnv 부재 시 계정을 조용히
// 무시한다(레거시 계약) — env 없는 프로바이더에 디렉터리를 강제하지 않는다.

/** Build only an explicit-id resume for a credential migration. The ordinary
 * provider `resumeCmd` (`codex resume --last`) is intentionally unavailable. */
export function providerCredentialMigrationCmd(
	provider: Provider,
	conversationId: string | null | undefined,
	account: AccountProfile | undefined,
	runtime: "local" | "ssh",
	skipPermissions?: boolean,
): string {
	assertCredentialMigrationSupported(provider, conversationId);
	return runtime === "local"
		? providerResumeIdCmd(
				provider,
				conversationId,
				account,
				skipPermissions,
			)
		: providerRunCmd(provider, {
				convId: conversationId,
				account,
				skipPermissions,
			});
}

/** 에이전트 설정에서 '권한 확인 건너뛰기'가 켜져 있으면 위험 플래그를 붙인다.
 *  플래그는 실행 파일 바로 뒤에 넣는다 — codex처럼 서브커맨드를 쓰는 CLI는
 *  맨 뒤에 붙이면 서브커맨드의 인자로 먹힌다. */
function applyPermissionFlag(
	provider: Provider,
	base: string,
	enabled: boolean,
): string {
  const flag = spec(provider).skipPermFlag;
  if (!flag || !enabled) return base;
  const [bin, ...rest] = base.split(" ");
  return [bin, flag, ...rest].join(" ");
}

function applyManagedLaunchPolicy(provider: Provider, base: string): string {
	if (provider !== "codex") return base;
	// Managed processes must never stop at Codex's interactive self-update
	// prompt. Dure promotes provider versions separately from a user turn.
	return base.replace(
		/^codex(?=\s|$)/,
		"codex -c check_for_update_on_startup=false",
	);
}

function applyFlag(
	provider: Provider,
	base: string,
	override?: boolean,
): string {
	return applyPermissionFlag(
		provider,
		applyManagedLaunchPolicy(provider, base),
		override ?? Boolean(useStore.getState().skipPermissions[provider]),
	);
}

/** Build a fresh managed-provider command from a persisted permission posture,
 * without rereading mutable frontend state after the recovery fence. */
export function providerFreshManagedCmd(
	provider: Provider,
	permissionMode: "default" | "bypass_approvals",
): string {
	return applyPermissionFlag(
		provider,
		applyManagedLaunchPolicy(provider, spec(provider).cmd),
		permissionMode === "bypass_approvals",
	);
}

/** 원격(SSH) 실행 명령 — 플래그 반영 + account를 주면 원격 계정 디렉터리에서 실행한다.
 *  account를 안 주면 원격 호스트에 로그인된 CLI를 그대로 쓴다. */
export function providerRunCmd(
  provider: Provider,
	opts: {
		resume?: boolean;
		convId?: string;
		fork?: boolean;
		forkConversationId?: string;
		account?: AccountProfile;
		/** 에이전트별 권한 플래그 고정값 — 없으면 전역 설정 */
		skipPermissions?: boolean;
	} = {},
): string {
  const p = spec(provider);
  if (opts.fork && !p.conversationFork) {
    throw new Error(`${p.label} has no reviewed conversation fork adapter`);
  }
  if (opts.fork && p.conversationFork === "native_fork" && !p.forkId) {
    throw new Error(`${p.label} native fork command is unavailable`);
  }
  if (
    opts.fork &&
    p.conversationFork === "native_fork_generated" &&
    !p.forkSource
  ) {
    throw new Error(`${p.label} generated fork command is unavailable`);
  }
  if (opts.fork && p.conversationFork === "copy_and_flag" && !p.forkFlag) {
    throw new Error(`${p.label} copy fork flag is unavailable`);
  }
  if (opts.fork && !opts.convId) {
    throw new Error("fork_source_conversation_identity_required");
  }
  let base: string;
  if (opts.convId !== undefined) {
    if (!opts.convId.trim()) {
      throw new Error("conversation_identity_required");
    }
    if (!p.resumeId) {
      throw new ProviderExplicitResumeUnsupportedError(provider);
    }
    if (
      opts.fork &&
      p.conversationFork === "native_fork_generated" &&
      p.forkSource
    ) {
      base = p.forkSource(opts.convId);
    } else if (opts.fork && p.forkId) {
      if (!opts.forkConversationId?.trim()) {
        throw new Error("fork_conversation_identity_required");
      }
      base = p.forkId(opts.convId, opts.forkConversationId);
    } else {
      base = p.resumeId(opts.convId);
    }
    // Provider-generated fork와 copy-and-flag fork는 child identity를 launch
    // command에서 추측하지 않는다. Host의 provider event가 새 ID를 투영한다.
    if (opts.fork && p.forkFlag) base += ` ${p.forkFlag}`;
  } else {
    // Fresh/latest selection applies only when no exact identity was requested.
    base = opts.resume ? (p.resumeCmd ?? p.cmd) : p.cmd;
  }
  // 플래그를 먼저 붙인다 — 실행 파일 이름 기준으로 삽입하므로 env 프리픽스가 앞서면 안 된다.
	return (
		remoteAccountPrefix(provider, opts.account) +
		applyFlag(provider, base, opts.skipPermissions)
	);
}

/** 계정 env를 입힌 프로바이더 실행 명령. 로컬 세션 전용 —
 *  SSH 에이전트는 원격 호스트의 자체 인증을 쓴다. */
export function providerCmd(
  provider: Provider,
  resume: boolean,
  account = activeAccount(provider),
  skipPermissions?: boolean,
): string {
	return (
		localAccountPrefix(provider, account) +
		providerRunCmd(provider, { resume, skipPermissions })
	);
}

/** Provider-native id로 특정 대화를 정확히 재개하는 명령. */
export function providerResumeIdCmd(
  provider: Provider,
  convId: string,
  account = activeAccount(provider),
	skipPermissions?: boolean,
): string {
	return (
		localAccountPrefix(provider, account) +
		providerRunCmd(provider, { convId, skipPermissions })
	);
}

/** Whether the reviewed provider adapter can resume one exact conversation.
 * Recovery must never substitute a provider's "continue latest" command. */
export function providerSupportsExplicitResume(provider: Provider): boolean {
	return typeof spec(provider).resumeId === "function";
}

/** Whether the reviewed adapter can enumerate exact provider-native
 * conversations for the current workspace. */
export function providerSupportsConversationListing(
	provider: Provider,
): boolean {
	return spec(provider).conversationList !== undefined;
}

/** Exact resume is not necessarily a safe cross-worktree fork. Only providers
 * with a reviewed copy/branch strategy may inherit a conversation on fork. */
export function providerConversationForkStrategy(
	provider: Provider,
): ProviderSpec["conversationFork"] {
	return spec(provider).conversationFork;
}

export function providerSupportsConversationFork(provider: Provider): boolean {
	return providerConversationForkStrategy(provider) !== undefined;
}

export class ProviderExplicitResumeUnsupportedError extends Error {
	readonly code = "explicit_resume_unsupported";

	constructor(readonly provider: Provider) {
		super(`${spec(provider).label} has no reviewed explicit-conversation resume adapter`);
		this.name = "ProviderExplicitResumeUnsupportedError";
	}
}

export function providerRecoveryResumeCmd(
	provider: Provider,
	conversationId: string,
	account = activeAccount(provider),
): string {
	return providerResumeIdCmd(provider, conversationId, account);
}

/** 특정 대화를 포크해서 시작하는 명령 — 원본 세션은 건드리지 않는다 */
export function providerForkIdCmd(
  provider: Provider,
  convId: string,
  forkConversationId?: string,
  account = activeAccount(provider),
): string {
	if (!providerSupportsConversationFork(provider)) {
		throw new Error(`${spec(provider).label} has no reviewed conversation fork adapter`);
	}
  return (
		localAccountPrefix(provider, account) +
		providerRunCmd(provider, { convId, fork: true, forkConversationId })
	);
}

/** 계정 로그인용 명령 (로그인 터미널 패널에서 실행) */
export function loginCmd(account: AccountProfile): string {
	return providerLoginCmd(account.provider, account);
}

/** Provider login command for either the system credential or one profile. */
export function providerLoginCmd(
	provider: Provider,
	account?: AccountProfile,
): string {
	return localAccountPrefix(provider, account) + loginBase(provider);
}

/** 원격 호스트에서 이 계정으로 로그인하는 명령 — 자격증명은 원격에만 생긴다. */
export function remoteLoginCmd(account: AccountProfile): string {
	return (
		remoteAccountPrefix(account.provider, account) +
		(spec(account.provider).remoteLoginCmd ?? loginBase(account.provider))
	);
}

function loginBase(provider: Provider): string {
  const p = spec(provider);
  return p.loginCmd ?? p.cmd;
}
