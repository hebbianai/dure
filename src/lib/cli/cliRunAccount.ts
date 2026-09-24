import { resolveAgentLaunchCredential } from "@/lib/agents/agentLaunchCredential";
import { providerAccountDirectoryName } from "@/lib/agents/providers";
import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import { isDureBackendProfileIdV1 } from "@/lib/ipc/dureProtocolIdentity";
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
		typeof params.providerId !== "string" ||
		!Object.keys(PROVIDERS).includes(params.providerId) ||
		!isDureBackendProfileIdV1(params.backendProfileId) ||
		(params.account !== undefined &&
			(typeof params.account !== "string" || !params.account))
	) {
		throw new Error(
			"A provider, backend profile and optional account ID are required.",
		);
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
