import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import type { AgentInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import {
	providerSupportsConversationListing,
	providerSupportsExplicitResume,
	remoteAccountDir,
} from "@/lib/agents/providers";
import type { ConversationCredentialProfile } from "@/lib/ipc";
import type { TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import type {
	AccountProfile,
	Agent,
	AgentActivity,
	HmuxManagedStopFenceV1,
	Project,
	Provider,
} from "@/types";

/** Maps the Agent's credential authority to its provider-owned history root.
 * The account registry resolves only the opaque reference; provider adapters
 * remain the authority for directory layout. */
export function conversationHistoryCredentialProfile(input: {
	agent: Pick<
		Agent,
		| "provider"
		| "executionProfile"
		| "runtimeBinding"
		| "credentialId"
		| "accountId"
	>;
	accounts: readonly AccountProfile[];
	remote: boolean;
}): ConversationCredentialProfile | undefined {
	if (!providerSupportsConversationListing(input.agent.provider))
		return undefined;
	const referenceId = agentCredentialReferenceId(input.agent);
	if (!referenceId) return undefined;
	const binding = input.agent.runtimeBinding;
	if (
		input.remote &&
		binding?.runtime === "hmux_managed_v1" &&
		binding.source === "ssh" &&
		binding.credentialId === referenceId &&
		binding.credentialProfileDirectory
	) {
		return {
			referenceId,
			directory: binding.credentialProfileDirectory,
		};
	}
	const account = input.accounts.find(
		(candidate) =>
			candidate.provider === input.agent.provider &&
			candidate.id === referenceId,
	);
	if (!account) throw new Error("credential_reference_unavailable");
	return {
		referenceId: account.id,
		directory: input.remote ? remoteAccountDir(account) : account.dir,
	};
}

interface ConversationHistoryNativeAuthorityV1 {
	sessionId: string;
	workspaceId: string;
	createIdempotencyKey: string | null;
	backendProfileId: string | null;
	credentialId: string | null;
	credentialGeneration: number | null;
	providerConversationRef: string | null;
	stopFence: HmuxManagedStopFenceV1 | null;
}

export interface ConversationHistorySourceAuthorityV1 {
	agentId: string;
	provider: Provider;
	projectId: string;
	projectKind: Project["kind"];
	projectPath: string;
	projectSshHostId: string | null;
	workspaceRoot: string;
	branch: string;
	backendProfileId: string | null;
	interactionSessionId: string | null;
	executionProfile: Agent["executionProfile"] | null;
	credentialId: string | null;
	providerConversationRef: string | null;
	permissionMode: "default" | "skip_permissions";
	native: ConversationHistoryNativeAuthorityV1 | null;
}

/** Semantic client authority for one live history action. Display-only names,
 * object identity, and conversation-observation revisions are intentionally
 * excluded; the backend plan separately fences the durable selection/binding. */
export function conversationHistorySourceAuthority(
	agent: Agent,
	project: Project,
): ConversationHistorySourceAuthorityV1 {
	const binding = agent.runtimeBinding;
	const native =
		binding?.runtime === "hmux_managed_v1" && binding.source === "local"
			? {
					sessionId: binding.sessionId,
					workspaceId: binding.workspaceId,
					createIdempotencyKey: binding.createIdempotencyKey ?? null,
					backendProfileId: binding.backendProfileId ?? null,
					credentialId: binding.credentialId ?? null,
					credentialGeneration: binding.credentialGeneration ?? null,
					providerConversationRef:
						binding.conversationIdentity?.conversationId ?? null,
					stopFence: binding.stopFence ? { ...binding.stopFence } : null,
				}
			: null;
	const profile = agent.interactionProfile;
	return {
		agentId: agent.id,
		provider: agent.provider,
		projectId: agent.projectId,
		projectKind: project.kind,
		projectPath: project.path,
		projectSshHostId: project.sshHostId ?? null,
		workspaceRoot: agent.worktreePath,
		branch: agent.branch,
		backendProfileId:
			profile?.kind === "structured_protocol"
				? profile.backendProfileId
				: (native?.backendProfileId ??
					agent.canonicalSpawn?.backendProfileId ??
					null),
		interactionSessionId:
			profile?.kind === "structured_protocol"
				? profile.interactionSessionId
				: null,
		executionProfile: agent.executionProfile
			? { ...agent.executionProfile }
			: null,
		credentialId: agent.credentialId ?? null,
		providerConversationRef: agent.conversationId ?? null,
		permissionMode: agent.skipPermissions ? "skip_permissions" : "default",
		native,
	};
}

export function sameConversationHistorySourceAuthority(
	left: ConversationHistorySourceAuthorityV1,
	right: ConversationHistorySourceAuthorityV1,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** A live history action may create a sibling only when the source runtime can
 * preserve the current process and the provider can enumerate exact records. */
export interface ConversationHistoryAvailabilityInput {
	activity: AgentActivity;
	binding: TerminalPaneBindingV1 | undefined;
	interactionProfile?: AgentInteractionProfileV1;
	projectKind: Project["kind"] | undefined;
	provider: Provider;
}

/** pane 톱바 ⋮의 "최근 작업" 항목 가용성 — AgentPanel의 대화 기록 컨트롤이
 *  마운트되는 조건과 동일해야 열기 신호가 허공에 뜨지 않는다. */
export function conversationHistoryMenuAvailable(
	input: ConversationHistoryAvailabilityInput,
): boolean {
	return (
		input.activity === "exited" ||
		managedLiveConversationHistoryAvailable(input)
	);
}

export function managedLiveConversationHistoryAvailable(input: {
	activity: AgentActivity;
	binding: TerminalPaneBindingV1 | undefined;
	interactionProfile?: AgentInteractionProfileV1;
	projectKind: Project["kind"] | undefined;
	provider: Provider;
}): boolean {
	return (
		((input.binding?.runtime === "hmux_managed_v1" &&
			input.binding.source === "local") ||
			input.interactionProfile?.kind === "structured_protocol") &&
		input.projectKind === "local" &&
		providerSupportsConversationListing(input.provider) &&
		providerSupportsExplicitResume(input.provider) &&
		input.activity !== "exited"
	);
}
