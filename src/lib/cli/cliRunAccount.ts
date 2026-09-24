import { resolveAgentLaunchCredential } from "@/lib/agents/agentLaunchCredential";
import { providerAccountDirectoryName } from "@/lib/agents/providers";
import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import {
	isDureBackendProfileIdV1,
	isDureDomainIdV1,
} from "@/lib/ipc/dureProtocolIdentity";
import { registerDureProviderCredentialProfile } from "@/lib/ipc/dureProviderCredentialProfile";
import { useStore } from "@/store";
import { type AccountProfile, PROVIDERS, type Provider } from "@/types";

export async function resolveCliRunAccount(
	params: Record<string, unknown>,
	dependencies = {
		readState: (): {
			accounts: readonly AccountProfile[];
			activeAccounts: Partial<Record<Provider, string>>;
		} => useStore.getState(),
		resolveRoute: resolveSelectedDureBackendRouteAuthority,
		register: registerDureProviderCredentialProfile,
	},
) {
	if (
		!isDureDomainIdV1(params.providerId) ||
		!isDureBackendProfileIdV1(params.backendProfileId) ||
		(params.account !== undefined &&
			(typeof params.account !== "string" || !params.account))
	) {
		throw new Error(
			"A provider, backend profile and optional account ID are required.",
		);
	}
	// Backend extensions can launch headlessly without a desktop account model.
	// An explicit account must still be resolved by a supported provider adapter.
	if (!Object.keys(PROVIDERS).includes(params.providerId)) {
		if (params.account !== undefined && params.account !== "default")
			throw new Error("Account selection is unavailable for this provider.");
		return {
			ok: true,
			schemaVersion: 1,
			executionProfile: { kind: "provider_default" },
		};
	}
	const provider = params.providerId as Provider;
	const state = dependencies.readState();
	const selected = resolveAgentLaunchCredential({
		provider,
		accounts: state.accounts,
		activeAccountId: state.activeAccounts[provider],
		requestedAccountId:
			params.account === "default"
				? null
				: (params.account as string | undefined),
	});
	if (!selected.account)
		return {
			ok: true,
			schemaVersion: 1,
			executionProfile: { kind: "provider_default" },
		};
	const account = { ...selected.account };
	const routeAuthority = await dependencies.resolveRoute(
		params.backendProfileId,
	);
	const executionProfile = await dependencies.register(
		{
			providerId: provider,
			referenceId: account.id,
			profileDirectoryName: providerAccountDirectoryName(account),
		},
		{ profileId: routeAuthority.profileId, routeAuthority },
	);
	return { ok: true, schemaVersion: 1, executionProfile };
}
