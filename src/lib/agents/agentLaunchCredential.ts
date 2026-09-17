import {
	ProviderCredentialUnsupportedError,
	providerSupportsAccountProfiles,
} from "@/lib/agents/providerCredentials";
import type {
	AccountProfile,
	Agent,
	AgentRuntimeBindingV1,
	Project,
	Provider,
	TerminalEnvironment,
} from "@/types";

export class AgentLaunchCredentialUnavailableError extends Error {
	readonly code = "agent_launch_credential_unavailable";

	constructor(
		readonly provider: Provider,
		readonly credentialId: string,
	) {
		super(
			`credential reference is unavailable for ${provider}: ${credentialId}`,
		);
		this.name = "AgentLaunchCredentialUnavailableError";
	}
}

export interface AgentLaunchCredentialSelection {
	/** A managed launch is pinned even when the provider default is selected. */
	accountId?: string | null;
	/** Non-secret credential reference copied into the managed Host binding. */
	credentialId?: string;
	account?: AccountProfile;
}

/** Returns the credential reference committed to an Agent runtime. New
 * runtimes own this fact in executionProfile; the remaining fields are the
 * persisted compatibility projection for panes created before that field
 * existed. An explicit provider_default always wins over stale legacy data. */
export function agentCredentialReferenceId(
	agent: Pick<
		Agent,
		"executionProfile" | "runtimeBinding" | "credentialId" | "accountId"
	>,
): string | undefined {
	if (agent.executionProfile?.kind === "provider_default") return undefined;
	if (agent.executionProfile?.kind === "credential_reference") {
		return agent.executionProfile.reference_id;
	}
	const bindingCredentialId =
		agent.runtimeBinding?.runtime === "hmux_managed_v1"
			? agent.runtimeBinding.credentialId
			: undefined;
	return (
		bindingCredentialId ??
		agent.credentialId ??
		(typeof agent.accountId === "string" ? agent.accountId : undefined)
	);
}

/**
 * Resolve the initial account once, before worktree or provider side effects.
 *
 * `requestedAccountId=undefined` snapshots the provider's active account for
 * legacy callers. `null` explicitly pins the provider default. The returned
 * selection never follows a later global-account change, because a running
 * provider process cannot change credentials without a safe replacement.
 */
export function resolveAgentLaunchCredential(input: {
	provider: Provider;
	requestedAccountId?: string | null;
	activeAccountId?: string;
	accounts: readonly AccountProfile[];
}): AgentLaunchCredentialSelection {
	if (!providerSupportsAccountProfiles(input.provider)) {
		if (typeof input.requestedAccountId === "string") {
			throw new ProviderCredentialUnsupportedError(input.provider);
		}
		return {};
	}

	const credentialId =
		input.requestedAccountId === undefined
			? input.activeAccountId
			: (input.requestedAccountId ?? undefined);
	if (!credentialId) return { accountId: null };

	const account = input.accounts.find(
		(candidate) =>
			candidate.id === credentialId && candidate.provider === input.provider,
	);
	if (!account) {
		throw new AgentLaunchCredentialUnavailableError(
			input.provider,
			credentialId,
		);
	}
	return {
		accountId: account.id,
		credentialId: account.id,
		account,
	};
}

/** Initial dialog value. Stale persisted active pointers fail safe to default. */
export function initialAgentLaunchAccountId(
	provider: Provider,
	accounts: readonly AccountProfile[],
	activeAccountId?: string,
): string | null {
	if (!providerSupportsAccountProfiles(provider) || !activeAccountId) {
		return null;
	}
	return accounts.some(
		(account) =>
			account.id === activeAccountId && account.provider === provider,
	)
		? activeAccountId
		: null;
}

/** Pure registration builder: the Agent and managed binding receive one exact
 * launch selection, so later global-account changes cannot split their truth. */
/** Initial runtime binding for a newly registered agent on this project.
 * Local and ssh both ride the managed Hmux runtime — the single authority for
 * this literal (registration, fork, and adoption all build it here). A project
 * without a resolvable host gets no binding and fails visibly at spawn. */
export function initialAgentRuntimeBinding(input: {
	project: Project;
	sessionId: string;
	credentialId?: string;
}): AgentRuntimeBindingV1 | undefined {
	const credential = input.credentialId
		? { credentialId: input.credentialId }
		: {};
	if (input.project.kind === "local") {
		return {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			sessionId: input.sessionId,
			workspaceId: input.project.id,
			createIdempotencyKey: input.sessionId,
			...credential,
		};
	}
	return input.project.sshHostId
		? {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: input.project.sshHostId,
				sessionId: input.sessionId,
				workspaceId: input.project.id,
				createIdempotencyKey: input.sessionId,
				commandBridgeNonce: `bridge_${input.sessionId}`,
				...credential,
			}
		: undefined;
}

export function buildInitialAgentRegistration(input: {
	id: string;
	name: string;
	provider: Provider;
	project: Project;
	worktreePath: string;
	branch: string;
	terminalEnv?: TerminalEnvironment;
	credential: AgentLaunchCredentialSelection;
	/** 권한 확인 건너뛰기 — undefined면 전역 설정을 따른다 */
	skipPermissions?: boolean;
}): Agent {
	const credential = input.credential.credentialId
		? { credentialId: input.credential.credentialId }
		: {};
	return {
		id: input.id,
		name: input.name,
		provider: input.provider,
		projectId: input.project.id,
		worktreePath: input.worktreePath,
		branch: input.branch,
		sessionId: input.id,
		sessionKind: input.project.kind === "local" ? "pty" : "ssh",
		skipPermissions: input.skipPermissions,
		runtimeBinding: initialAgentRuntimeBinding({
			project: input.project,
			sessionId: input.id,
			credentialId: input.credential.credentialId,
		}),
		started: false,
		terminalEnv: input.terminalEnv,
		...(input.credential.accountId !== undefined
			? { accountId: input.credential.accountId }
			: {}),
		...credential,
	};
}
