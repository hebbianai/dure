import {
	sameAgentExecutionProfileV1,
	type AgentInteractionBindingV1,
	type AgentExecutionProfileV1,
} from "@/lib/agents/chat/agentConversationContract";
import type { SharedAgentConversationTarget } from "@/lib/agents/chat/sharedAgentConversation";
import { providerAccountDirectoryName } from "@/lib/agents/providers";
import { createAccountRecoveryClient } from "@/lib/ipc/dureAccountRecovery";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { sameDureBackendRouteAuthority } from "@/lib/ipc/dureBackendRoute";
import { registerDureProviderCredentialProfile } from "@/lib/ipc/dureProviderCredentialProfile";
import { t } from "@/lib/i18n";
import type { AccountProfile, Provider } from "@/types";

export interface SharedConversationAccount {
	id: string;
	name: string;
}

/** Remote conversations offer only credentials already registered on that server.
 * Personal accounts can be registered by an explicit selection on a local route. */
export async function sharedConversationAccounts(
	target: SharedAgentConversationTarget,
	provider: Provider,
	localAccounts: readonly AccountProfile[],
): Promise<SharedConversationAccount[]> {
	const snapshot = await createAccountRecoveryClient(
		target.authority.profileId,
	).get(provider, target.authority);
	const options = new Map<string, SharedConversationAccount>();
	for (const profile of snapshot.profiles) {
		options.set(profile.referenceId, {
			id: profile.referenceId,
			name: profile.referenceId,
		});
	}
	for (const account of snapshot.policy?.accounts ?? []) {
		if (options.has(account.profile.referenceId))
			options.set(account.profile.referenceId, {
				id: account.profile.referenceId,
				name: account.name,
			});
	}
	if (target.authority.target.source === "local") {
		for (const account of localAccounts) {
			if (account.provider === provider)
				options.set(account.id, { id: account.id, name: account.name });
		}
	}
	return [...options.values()];
}

/** A shared conversation has no IDE Agent or pane identity. Use the same runtime
 * service as panes, fenced by the conversation and server the user is viewing. */
export async function switchSharedConversationAccount(
	target: SharedAgentConversationTarget,
	binding: AgentInteractionBindingV1,
	accountId: string | null,
	localAccounts: readonly AccountProfile[],
) {
	const client = createDureAgentRuntimeClient({
		profileId: target.authority.profileId,
	});
	const source = await client.inspectExact(target.agentId, target.authority);
	if (
		source.state !== "stable" ||
		source.interactionProfile !== "structured_protocol" ||
		source.agentId !== binding.agentId ||
		source.providerId !== binding.providerId ||
		source.interactionSessionId !== binding.interactionSessionId ||
		source.providerConversationRef !== binding.providerConversationRef ||
		!sameAgentExecutionProfileV1(
			source.executionProfile,
			binding.executionProfile,
		) ||
		!sameDureBackendRouteAuthority(source.routeAuthority, target.authority) ||
		(source.binding &&
			(source.binding.runtime.runtimeGeneration !==
				binding.runtime.runtimeGeneration ||
				source.binding.runtime.providerEpoch !== binding.runtime.providerEpoch))
	)
		throw new Error(t("agents.runtime.switchFailed"));

	let executionProfile: AgentExecutionProfileV1 = { kind: "provider_default" };
	if (accountId !== null) {
		const local =
			target.authority.target.source === "local"
				? localAccounts.find(
						(account) =>
							account.id === accountId &&
							account.provider === source.providerId,
					)
				: undefined;
		if (local) {
			executionProfile = await registerDureProviderCredentialProfile(
				{
					providerId: source.providerId,
					referenceId: local.id,
					profileDirectoryName: providerAccountDirectoryName(local),
				},
				{
					profileId: target.authority.profileId,
					routeAuthority: target.authority,
				},
			);
		} else {
			const snapshot = await createAccountRecoveryClient(
				target.authority.profileId,
			).get(source.providerId, target.authority);
			const profile = snapshot.profiles.find(
				(profile) => profile.referenceId === accountId,
			);
			if (!profile) throw new Error(t("agents.runtime.switchFailed"));
			executionProfile = {
				kind: "credential_reference",
				reference_id: profile.referenceId,
				credential_generation: profile.credentialGeneration,
			};
		}
	}
	const result = await client.transition({
		agentId: target.agentId,
		expectedSourceRevision: source.selectionRevision,
		targetInteractionProfile: "structured_protocol",
		targetExecutionProfile: executionProfile,
		sourceStopPolicy: "preserve",
		routeAuthority: target.authority,
	});
	if (
		result.interactionProfile !== "structured_protocol" ||
		result.providerId !== source.providerId ||
		!sameAgentExecutionProfileV1(result.executionProfile, executionProfile) ||
		result.providerConversationRef !== source.providerConversationRef ||
		!sameDureBackendRouteAuthority(result.routeAuthority, target.authority)
	) {
		throw new Error(t("agents.runtime.switchFailed"));
	}
	return result;
}
