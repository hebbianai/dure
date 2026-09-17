import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import { agentRuntimeTransitionBackendProfileId } from "@/lib/agents/agentRuntimeProfileSwitch";
import { providerAccountDirectoryName } from "@/lib/agents/providers";
import type { ObservedProviderModelV1 } from "@/lib/agents/providerModels";
import {
	readProviderCatalog,
	type ProviderCatalogRequest,
} from "@/lib/ipc/providerCatalog";
import type { AccountProfile, Agent, Project, Provider } from "@/types";

export interface ProviderCatalogSource {
	readonly key: string;
	load(): Promise<readonly ObservedProviderModelV1[]>;
}

export function providerCatalogSource(
	provider: Provider,
	profileId: string,
	account?: AccountProfile,
): ProviderCatalogSource {
	const scope = {
		providerId: provider,
		profileId,
		accountId: account?.id,
		accountDirectory: account?.dir,
	};
	return {
		key: JSON.stringify(scope),
		load: async () => {
			if (account && account.provider !== provider)
				throw new Error("provider_catalog_credential_invalid");
			const request: ProviderCatalogRequest = {
				providerId: provider,
				profileId,
				...(account
					? {
							credentialProfile: {
								referenceId: account.id,
								profileDirectoryName: providerAccountDirectoryName(account),
							},
						}
					: {}),
			};
			return readProviderCatalog(request);
		},
	};
}

/** Resolve only the owning backend and selected credential; never substitute local/default. */
export function agentProviderCatalogSource(
	agent: Agent,
	project: Project | undefined,
	accounts: readonly AccountProfile[],
): ProviderCatalogSource {
	const profileId = agentRuntimeTransitionBackendProfileId(agent, project);
	const referenceId = agentCredentialReferenceId(agent);
	const account = accounts.find(
		(entry) => entry.id === referenceId && entry.provider === agent.provider,
	);
	if (!profileId || (referenceId && !account)) {
		return {
			key: JSON.stringify([agent.id, profileId, referenceId]),
			load: async () => {
				throw new Error("provider_catalog_scope_unavailable");
			},
		};
	}
	return providerCatalogSource(agent.provider, profileId, account);
}
