// ipc/sessions — 터미널 세션(pty/ssh 통합) 수명주기.
//
// ipc.ts 도메인 분할 1단계(2026-08-01): 내용은 구 src/lib/ipc.ts에서 그대로
// 옮겨졌고, 소비자는 barrel(src/lib/ipc.ts)을 통해 기존 경로를 유지한다.
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).

import { invoke } from "@tauri-apps/api/core";
import {
	isManagedCreateChainStopReceiptV2,
	type ManagedCreateReconcileIdentityV1,
} from "@/lib/hmux/managed/managedCreateChainStopReceipt";
import { managedCreateInvokeOutcomeUnknown } from "@/lib/hmux/managed/managedCreateResolution";
import {
	isRemoteHmuxCatalogReceiptV1,
	isRemoteHmuxHostTrustV1,
	isRemoteHmuxManagedRehostReceiptV1,
	isRemoteHmuxManagedStopReceiptV1,
	isRemoteHmuxProvisionReceiptV1,
	isRemoteHmuxStandaloneCreateReceiptV1,
	parseRemoteHmuxManagedCreateAdvanceResolutionV1,
	planRemoteHmuxCatalogTarget,
	type RemoteHmuxCatalogReceiptV1,
	type RemoteHmuxCatalogTargetV1,
	type RemoteHmuxHostTrustV1,
	type RemoteHmuxManagedCreateAdvanceResolutionV1,
	type RemoteHmuxManagedCreateChainStopRequestV2,
	type RemoteHmuxManagedCreateRequestV1,
	type RemoteHmuxManagedRehostReceiptV1,
	type RemoteHmuxManagedRehostReconcileRequestV1,
	type RemoteHmuxManagedRehostRequestV1,
	type RemoteHmuxManagedStopRequestV1,
	type RemoteHmuxProvisionReceiptV1,
	type RemoteHmuxStandaloneCreateReceiptV1,
	type RemoteHmuxStandaloneCreateRequestV1,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import { BACKEND_FEATURES } from "@/lib/platform/backendCompatibility";
import {
	type SshCommandSource,
	sshCommandExecution,
} from "@/lib/ssh/sshCommandExecution";
import { sshHostSecretId } from "@/lib/ssh/sshCredentialClaim";
import type { TrustedSshTargetV1 } from "@/lib/ssh/trustedSshTarget";
import type {
	Provider,
	SshConfigScan,
	SshCredentialClaimV1,
	SshHostConfig,
	TerminalEnvironment,
} from "@/types";
import { backendSupports } from "./core";
import type {
	ExecResult,
	HmuxCommandInputReceipt,
	HmuxInitialAgentPromptReceipt,
	HmuxManagedCreateChainStopReceipt,
	HmuxManagedStopReceipt,
	HmuxPaneDepartureReceipt,
	HmuxSessionSummary,
	ProviderPreflight,
} from "./hmux";
import {
	HmuxInputPreDispatchError,
	HmuxInputReceiptError,
	parseHmuxCommandInputReceipt,
	parseHmuxInitialAgentPromptReceipt,
} from "./hmuxInputReceipt";

// The legacy PTY/SSH session daemons are fully retired (2026-08-16). Only
// remote-exec (opts-based), credential overlay, conversation listing, and the
// remote-hmux transport wrappers remain in this module.

/** `hmux attach`로 연결된 durable Hmux session (pane-set 승인 검사용). */
export const querySessionHmux = (id: string) =>
	invoke<HmuxSessionSummary | null>("session_hmux", { id }).catch(() => null);

export const providerPreflight = (opts: {
	provider: Provider;
	command: string;
	cwd: string;
	terminalEnv?: TerminalEnvironment;
	/** Diagnostics include the version unless an executable-only caller opts out. */
	includeVersion?: boolean;
}) =>
	invoke<ProviderPreflight>("provider_preflight", {
		provider: opts.provider,
		command: opts.command,
		cwd: opts.cwd,
		terminalEnv: opts.terminalEnv ?? null,
		includeVersion: opts.includeVersion ?? true,
	});

export interface SshConnectOpts {
	host: string;
	port?: number;
	user: string;
	auth?: "auto" | "password" | "key";
	secretId?: string;
	/** Legacy localStorage migration fallback. */
	password?: string;
	keyPath?: string;
	hostKeyFingerprints?: readonly string[];
	passphrase?: string;
	/** 원격 hebbian-session 데몬 경로(있으면 지속). 없으면 생 셸. */
	sessionBin?: string;
	/** 데몬 세션 id */
	sessionId?: string;
	initialCommand?: string;
	cols?: number;
	rows?: number;
}

export function hostToOpts(h: SshHostConfig): SshConnectOpts {
	return {
		host: h.host,
		port: h.port,
		user: h.user,
		auth: h.auth,
		secretId: sshHostSecretId(h),
		password: h.password,
		keyPath: h.keyPath,
	};
}

export async function prepareTrustedSshTarget(
	hosts: readonly SshHostConfig[],
	hostId: string,
): Promise<TrustedSshTargetV1> {
	const host = hosts.find((candidate) => candidate.id === hostId);
	if (!host) throw new Error("trusted_ssh_host_not_registered");
	const trust = await remoteHmuxKnownHostTrust(host.id, host.host, host.port);
	return planRemoteHmuxCatalogTarget(hosts, host.id, trust);
}

export type { TrustedSshTargetV1 } from "@/lib/ssh/trustedSshTarget";

export const listProviderConversationRecords = <T>() =>
	invoke<T[]>("list_provider_conversations");

export const getProviderConversationDetails = <T>(
	provider: string,
	conversationId: string,
) =>
	invoke<T>("provider_conversation_details", {
		provider,
		conversationId,
	});

export const getRemoteProviderConversationDetails = <T>(
	hostId: string,
	opts: SshConnectOpts,
	provider: string,
	conversationId: string,
) =>
	invoke<T>("remote_provider_conversation_details", {
		hostId,
		opts,
		provider,
		conversationId,
	});

export const listRemoteProviderConversationRecords = <T>(
	hostId: string,
	opts: SshConnectOpts,
) => invoke<T[]>("list_remote_provider_conversations", { hostId, opts });

export const sshSecretSet = (id: string, value: string) =>
	invoke<void>("ssh_secret_set", { id, value });

export const sshSecretCopy = (source: string, destination: string) =>
	invoke<void>("ssh_secret_copy", { source, destination });

export const sshCredentialClaimStage = (
	claims: readonly SshCredentialClaimV1[],
) => invoke<void>("ssh_credential_claim_stage", { claims });

export const sshCredentialClaimActivate = (
	claims: readonly SshCredentialClaimV1[],
) => invoke<void>("ssh_credential_claim_activate", { claims });

export const sshCredentialClaimRetire = (
	claims: readonly SshCredentialClaimV1[],
) => invoke<void>("ssh_credential_claim_retire", { claims });

export const sshCredentialClaimReconcile = (
	liveClaims: readonly SshCredentialClaimV1[],
	referencedIds: readonly string[],
) =>
	invoke<{
		deleted: string[];
		retained: string[];
		failures: Array<{ id: string; error: string }>;
	}>("ssh_credential_claim_reconcile", { liveClaims, referencedIds });

export async function remoteHmuxCatalog(
	target: RemoteHmuxCatalogTargetV1,
): Promise<RemoteHmuxCatalogReceiptV1> {
	if (!(await backendSupports(BACKEND_FEATURES.hmuxRemoteCatalog))) {
		throw new Error("remote_hmux_catalog_backend_unavailable");
	}
	const { schemaVersion: _schemaVersion, ...request } = target;
	const receipt = await invoke<unknown>("remote_hmux_catalog", { request });
	if (!isRemoteHmuxCatalogReceiptV1(receipt, target.hostId)) {
		throw new Error("remote_hmux_catalog_receipt_invalid");
	}
	return receipt;
}

/**
 * 이 상자의 hmux 를 이 앱이 들고 있는 빌드로 맞춘다.
 *
 * 이미 최신이면 바이트를 하나도 안 올리고 `alreadyCurrent` 로 돌아온다. 그것도
 * 성공이고, 화면은 그렇게 그려야 한다.
 */
export async function remoteHmuxProvision(
	target: RemoteHmuxCatalogTargetV1,
): Promise<RemoteHmuxProvisionReceiptV1> {
	if (!(await backendSupports(BACKEND_FEATURES.hmuxRemoteProvision))) {
		throw new Error("remote_hmux_provision_backend_unavailable");
	}
	const { schemaVersion: _schemaVersion, ...request } = target;
	const receipt = await invoke<unknown>("remote_hmux_provision", { request });
	if (!isRemoteHmuxProvisionReceiptV1(receipt, target.hostId)) {
		throw new Error("remote_hmux_provision_receipt_invalid");
	}
	return receipt;
}

export async function remoteHmuxStandaloneCreate(
	input: RemoteHmuxStandaloneCreateRequestV1,
	pendingOwnerId: string,
): Promise<RemoteHmuxStandaloneCreateReceiptV1> {
	if (!(await backendSupports(BACKEND_FEATURES.hmuxRemoteCreate))) {
		throw new Error("remote_hmux_create_backend_unavailable");
	}
	const { schemaVersion: _schemaVersion, ...target } = input.target;
	const receipt = await invoke<unknown>("remote_hmux_standalone_create", {
		request: {
			...input,
			pendingOwnerId,
			target,
		},
	});
	if (
		!isRemoteHmuxStandaloneCreateReceiptV1(receipt, {
			requestId: input.requestId,
			bridgeNonce: input.bridgeNonce,
			targetSessionId: input.targetSessionId,
		})
	) {
		throw new Error("remote_hmux_create_receipt_invalid");
	}
	return receipt;
}

export async function remoteHmuxManagedCreateAdvance(
	input: RemoteHmuxManagedCreateRequestV1,
): Promise<RemoteHmuxManagedCreateAdvanceResolutionV1> {
	if (
		!(await backendSupports(BACKEND_FEATURES.hmuxRemoteManagedCreateAdvanceV1))
	) {
		throw new Error(
			"remote_hmux_managed_create_advance_v1_backend_unavailable",
		);
	}
	const { schemaVersion: _schemaVersion, ...target } = input.target;
	const { initialPrompt, ...baseInput } = input;
	const launchPromptSupported =
		initialPrompt !== undefined &&
		(await backendSupports(BACKEND_FEATURES.hmuxManagedLaunchPromptV1));
	let receipt: unknown;
	try {
		receipt = await invoke<unknown>("remote_hmux_managed_create_advance_v1", {
			request: {
				...baseInput,
				target,
				...(launchPromptSupported ? { initialPrompt } : {}),
			},
		});
	} catch (error) {
		throw managedCreateInvokeOutcomeUnknown(error);
	}
	const resolution = parseRemoteHmuxManagedCreateAdvanceResolutionV1(receipt, {
		idempotencyKey: input.idempotencyKey,
		bridgeNonce: input.bridgeNonce,
		sessionId: input.sessionId,
		workspaceId: input.workspaceId,
		providerId: input.providerId,
	});
	if (!resolution) {
		throw managedCreateInvokeOutcomeUnknown(
			new Error("remote_hmux_managed_create_resolution_invalid"),
		);
	}
	return resolution;
}

export async function remoteHmuxManagedRehost(
	input: RemoteHmuxManagedRehostRequestV1,
): Promise<RemoteHmuxManagedRehostReceiptV1> {
	if (!(await backendSupports(BACKEND_FEATURES.hmuxRemoteManagedRehost))) {
		throw new Error("remote_hmux_managed_rehost_backend_unavailable");
	}
	const { schemaVersion: _schemaVersion, ...target } = input.target;
	const receipt = await invoke<unknown>("remote_hmux_managed_rehost", {
		request: { ...input, target },
	});
	if (
		!isRemoteHmuxManagedRehostReceiptV1(receipt, {
			operationId: input.operationId,
			bridgeNonce: input.bridgeNonce,
			sourceSessionId: input.sourceSessionId,
			sourceWorkspaceId: input.sourceWorkspaceId,
		})
	) {
		throw new Error("remote_hmux_managed_rehost_receipt_invalid");
	}
	return receipt;
}

export async function remoteHmuxManagedRehostReconcile(
	input: RemoteHmuxManagedRehostReconcileRequestV1,
): Promise<RemoteHmuxManagedRehostReceiptV1 | null> {
	if (!(await backendSupports(BACKEND_FEATURES.hmuxRemoteManagedRehost))) {
		throw new Error("remote_hmux_managed_rehost_backend_unavailable");
	}
	const { schemaVersion: _schemaVersion, ...target } = input.target;
	const receipt = await invoke<unknown>(
		"remote_hmux_managed_rehost_reconcile",
		{
			request: {
				target,
				operationId: input.operationId,
				sourceSessionId: input.sourceSessionId,
				sourceWorkspaceId: input.sourceWorkspaceId,
				bridgeNonce: input.bridgeNonce,
			},
		},
	);
	if (receipt === null) return null;
	if (
		!isRemoteHmuxManagedRehostReceiptV1(receipt, {
			operationId: input.operationId,
			bridgeNonce: input.bridgeNonce,
			sourceSessionId: input.sourceSessionId,
			sourceWorkspaceId: input.sourceWorkspaceId,
		})
	) {
		throw new Error("remote_hmux_managed_rehost_receipt_invalid");
	}
	return receipt;
}

export async function remoteHmuxManagedStop(
	input: RemoteHmuxManagedStopRequestV1,
): Promise<HmuxManagedStopReceipt> {
	if (!(await backendSupports(BACKEND_FEATURES.hmuxRemoteManagedStop))) {
		throw new Error("remote_hmux_managed_stop_backend_unavailable");
	}
	const { schemaVersion: _schemaVersion, ...target } = input.target;
	const receipt = await invoke<unknown>("remote_hmux_managed_stop", {
		request: {
			target,
			stopId: input.stopId,
			sessionId: input.sessionId,
			workspaceId: input.workspaceId,
			expectedFence: input.expectedFence,
		},
	});
	if (
		!isRemoteHmuxManagedStopReceiptV1(receipt, {
			stopId: input.stopId,
			sessionId: input.sessionId,
			workspaceId: input.workspaceId,
			runnerPrincipal: input.expectedFence.runnerPrincipal,
			runnerInstance: input.expectedFence.runnerInstance,
			channelEpoch: input.expectedFence.channelEpoch,
			hostInstanceId: input.expectedFence.hostInstanceId,
			terminalEpoch: input.expectedFence.terminalEpoch,
		})
	) {
		throw new Error("remote_hmux_managed_stop_receipt_invalid");
	}
	return receipt;
}

export async function remoteHmuxManagedCreateChainStop(
	input: RemoteHmuxManagedCreateChainStopRequestV2,
): Promise<HmuxManagedCreateChainStopReceipt> {
	if (
		!(await backendSupports(
			BACKEND_FEATURES.hmuxRemoteManagedCreateChainStopV2,
		))
	) {
		throw new Error(
			"remote_hmux_managed_create_chain_stop_v2_backend_unavailable",
		);
	}
	const { schemaVersion: _schemaVersion, ...target } = input.target;
	const value = await invoke<unknown>(
		"remote_hmux_managed_create_chain_stop_v2",
		{
			request: {
				target,
				idempotencyKey: input.idempotencyKey,
				sessionId: input.sessionId,
				workspaceId: input.workspaceId,
			},
		},
	);
	if (
		!isManagedCreateChainStopReceiptV2(value, {
			idempotencyKey: input.idempotencyKey,
			sessionId: input.sessionId,
			workspaceId: input.workspaceId,
		})
	) {
		throw new Error("remote_hmux_managed_create_chain_stop_receipt_invalid");
	}
	return value;
}

/** Read the already-closed lifetime and finish only its retained checkout work. */
export async function reconcileManagedCreateChainStop(input: {
	idempotencyKey: string;
	sessionId: string;
	workspaceId: string;
	target?: TrustedSshTargetV1;
}): Promise<HmuxManagedCreateChainStopReceipt | null> {
	const { target: authority, ...identity } = input;
	const request: ManagedCreateReconcileIdentityV1 = {
		schema: "hmux-managed-create-reconcile-v1",
		schemaVersion: 1,
		...identity,
	};
	let target: Omit<TrustedSshTargetV1, "schemaVersion"> | undefined;
	if (authority) {
		const { schemaVersion: _schemaVersion, ...address } = authority;
		target = address;
	}
	const value = await invoke<unknown>(
		"session_checkout_reconcile_managed_close_v1",
		{
			request,
			target: target ?? null,
		},
	);
	if (value === null) return null;
	if (!isManagedCreateChainStopReceiptV2(value, request)) {
		throw new Error("managed_create_chain_stop_reconcile_receipt_invalid");
	}
	return value;
}

export async function remoteHmuxAbandonUnpresented(input: {
	target: RemoteHmuxCatalogTargetV1;
	requestId: string;
	sessionId: string;
	workspaceId: string;
	launchOwnerProof: string;
}): Promise<HmuxPaneDepartureReceipt> {
	const { schemaVersion: _schemaVersion, ...target } = input.target;
	const receipt = await invoke<unknown>(
		"remote_hmux_standalone_abandon_unpresented",
		{
			request: {
				requestId: input.requestId,
				sessionId: input.sessionId,
				workspaceId: input.workspaceId,
				launchOwnerProof: input.launchOwnerProof,
				target,
			},
		},
	);
	return requirePaneDepartureReceipt(receipt);
}

export async function remoteHmuxKnownHostTrust(
	hostId: string,
	host: string,
	port: number,
): Promise<RemoteHmuxHostTrustV1> {
	if (!(await backendSupports(BACKEND_FEATURES.hmuxRemoteKnownHostTrust))) {
		throw new Error("remote_hmux_known_host_trust_backend_unavailable");
	}
	const fingerprints = await invoke<unknown>(
		"remote_hmux_known_host_fingerprints",
		{ host, port },
	);
	const trust = {
		schemaVersion: 1,
		hostId,
		hostKeyFingerprints: fingerprints,
	};
	if (
		!Array.isArray(fingerprints) ||
		fingerprints.some((value) => typeof value !== "string") ||
		!isRemoteHmuxHostTrustV1(trust)
	) {
		throw new Error("remote_hmux_known_host_trust_invalid");
	}
	return trust;
}

export async function remoteHmuxCommandInput(input: {
	target: RemoteHmuxCatalogTargetV1;
	session: RemoteHmuxCatalogReceiptV1["sessions"][number];
	text: string;
	submit: boolean;
}): Promise<HmuxCommandInputReceipt> {
	if (!(await backendSupports(BACKEND_FEATURES.hmuxRemoteExactInput))) {
		throw new Error("remote_hmux_exact_input_backend_unavailable");
	}
	const { schemaVersion: _schemaVersion, ...target } = input.target;
	const value = await invoke<unknown>("remote_hmux_command_input", {
		request: {
			text: input.text,
			submit: input.submit,
			session: input.session,
			target,
		},
	});
	if (!value || typeof value !== "object") {
		throw new HmuxInputReceiptError("remote_hmux_input_receipt_invalid");
	}
	const receipt = value as Record<string, unknown>;
	if (
		receipt.hostId !== input.target.hostId ||
		receipt.sessionId !== input.session.sessionId ||
		receipt.workspaceId !== input.session.workspaceId
	) {
		throw new HmuxInputReceiptError("remote_hmux_input_receipt_invalid");
	}
	return parseHmuxCommandInputReceipt(receipt, {
		terminalEpoch: input.session.terminalEpoch,
		text: input.text.length > 0,
		submit: input.submit,
	});
}

export async function remoteHmuxInitialAgentPrompt(input: {
	target: RemoteHmuxCatalogTargetV1;
	session: RemoteHmuxCatalogReceiptV1["sessions"][number];
	prompt: string;
}): Promise<HmuxInitialAgentPromptReceipt> {
	if (!(await backendSupports(BACKEND_FEATURES.hmuxRemoteInitialAgentPrompt))) {
		throw new HmuxInputPreDispatchError(
			"remote_hmux_initial_agent_prompt_backend_unavailable",
		);
	}
	const { schemaVersion: _schemaVersion, ...target } = input.target;
	const value = await invoke<unknown>("remote_hmux_initial_agent_prompt", {
		request: {
			prompt: input.prompt,
			session: input.session,
			target,
		},
	});
	if (!value || typeof value !== "object") {
		throw new HmuxInputReceiptError(
			"remote_hmux_initial_agent_prompt_receipt_invalid",
		);
	}
	const receipt = value as Record<string, unknown>;
	if (
		receipt.hostId !== input.target.hostId ||
		receipt.sessionId !== input.session.sessionId ||
		receipt.workspaceId !== input.session.workspaceId
	) {
		throw new HmuxInputReceiptError(
			"remote_hmux_initial_agent_prompt_receipt_invalid",
		);
	}
	return parseHmuxInitialAgentPromptReceipt(
		receipt,
		input.session.terminalEpoch,
	);
}

function requirePaneDepartureReceipt(value: unknown): HmuxPaneDepartureReceipt {
	if (!value || typeof value !== "object") {
		throw new Error("hmux_pane_departure_receipt_invalid");
	}
	const receipt = value as Partial<HmuxPaneDepartureReceipt>;
	if (
		![
			"policy_updated",
			"retirement_armed",
			"eligible",
			"session_preserved",
			"refused",
		].includes(receipt.state ?? "") ||
		(receipt.reason !== undefined && typeof receipt.reason !== "string") ||
		(receipt.policy !== undefined &&
			(receipt.policy.kind !== "after_graceful_last_client_departure_v1" ||
				!Number.isInteger(receipt.policy.gracePeriodMs) ||
				receipt.policy.gracePeriodMs < 1_000 ||
				receipt.policy.gracePeriodMs > 300_000))
	) {
		throw new Error("hmux_pane_departure_receipt_invalid");
	}
	return receipt as HmuxPaneDepartureReceipt;
}

export async function remoteHmuxDepartGracefully(
	target: RemoteHmuxCatalogTargetV1,
	remoteSession: RemoteHmuxCatalogReceiptV1["sessions"][number],
	ownerId: string,
): Promise<HmuxPaneDepartureReceipt> {
	if (!(await backendSupports(BACKEND_FEATURES.hmuxRemotePaneDeparture))) {
		throw new Error("remote_hmux_pane_departure_backend_unavailable");
	}
	const { schemaVersion: _schemaVersion, ...transportTarget } = target;
	const receipt = await invoke<unknown>("remote_hmux_pane_depart_gracefully", {
		request: {
			ownerId,
			session: remoteSession,
			target: transportTarget,
		},
	});
	return requirePaneDepartureReceipt(receipt);
}

export const sshExecOnce = (opts: SshConnectOpts, source: SshCommandSource) => {
	const execution = sshCommandExecution(source);
	return invoke<ExecResult>("ssh_exec_once", {
		opts,
		cmd: execution.command,
		...("stdin" in execution ? { stdin: execution.stdin } : {}),
	});
};

export interface RemoteAccountOverlayReceipt {
	remoteDirectory: string;
	credentialPresent: boolean;
}

export class SshCredentialOverlayBackendUnavailableError extends Error {
	readonly code = "remote_credential_overlay_backend_unavailable";

	constructor() {
		super("The running backend does not support SSH credential overlays");
		this.name = "SshCredentialOverlayBackendUnavailableError";
	}
}

async function requireSshCredentialOverlayBackend(): Promise<void> {
	if (!(await backendSupports(BACKEND_FEATURES.sshCredentialOverlay))) {
		throw new SshCredentialOverlayBackendUnavailableError();
	}
}

export async function sshPrepareAccountOverlay(
	opts: SshConnectOpts,
	provider: Provider,
	remoteDir: string,
	requireCredential: boolean,
): Promise<RemoteAccountOverlayReceipt> {
	await requireSshCredentialOverlayBackend();
	return invoke<RemoteAccountOverlayReceipt>("ssh_prepare_account_overlay", {
		opts,
		provider,
		remoteDir,
		requireCredential,
	});
}

/** `~/.ssh/config`(+Include)에서 호스트를 읽는다 — 설정 파일별로 묶여서 온다.
 *  읽기 전용이라 실패해도 등록된 호스트 목록에는 영향이 없다. */
export const sshConfigHosts = () => invoke<SshConfigScan>("ssh_config_hosts");

/** 로컬 계정의 자격증명 파일만 원격 계정 디렉터리로 복사한다. 복사된 파일명을 반환. */
export const sshCopyAccount = async (
	opts: SshConnectOpts,
	provider: Provider,
	localDir: string,
	remoteDir: string,
) => {
	await requireSshCredentialOverlayBackend();
	return invoke<string[]>("ssh_copy_account", {
		opts,
		provider,
		localDir,
		remoteDir,
	});
};
