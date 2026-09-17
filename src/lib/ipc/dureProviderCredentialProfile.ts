import {
	type AgentExecutionProfileV1,
	isAgentCredentialReferenceV1,
} from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";
import {
	createDureBackendRequester,
	type DureBackendInvoke,
	DureBackendRequestError,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { isDureDomainIdV1 } from "@/lib/ipc/dureProtocolIdentity";
import { asRecord as record } from "@/lib/payloadGuards";
import type { Provider } from "@/types";

const DIRECTORY_NAME = /^[A-Za-z0-9_-]{1,160}$/;
const SUPPORTED_PROVIDERS = new Set<Provider>(["claude", "codex"]);

export interface DureProviderCredentialProfileRegistrationV1 {
	providerId: Provider;
	referenceId: string;
	profileDirectoryName: string;
}

/** Credential-profile launch coverage of the detached backend. Keep this
 * provider-specific policy at the adapter boundary until a second provider
 * ships the same native fallback contract. */
export function supportsDureProviderCredentialSpawn(
	provider: Provider,
): boolean {
	return SUPPORTED_PROVIDERS.has(provider);
}

function contractError() {
	return new DureBackendRequestError(
		"provider_credential_profile_response_invalid",
		t("ipc.dureRun.invalidResponse"),
		{ kind: "contract" },
	);
}

export async function registerDureProviderCredentialProfile(
	request: DureProviderCredentialProfileRegistrationV1,
	options?: {
		profileId?: string;
		routeAuthority?: DureBackendRouteAuthorityV1;
		invokeCommand?: DureBackendInvoke;
	},
): Promise<Extract<AgentExecutionProfileV1, { kind: "credential_reference" }>> {
	if (
		!isAgentCredentialReferenceV1(request.referenceId) ||
		!DIRECTORY_NAME.test(request.profileDirectoryName) ||
		!request.profileDirectoryName.startsWith(`${request.providerId}-`)
	) {
		throw contractError();
	}
	const backendRequest = createDureBackendRequester({
		profileId: options?.profileId ?? "local",
		invokeCommand: options?.invokeCommand,
		invalidResponseCode: "provider_credential_profile_response_invalid",
		invalidResponseMessage: "ipc.dureRun.invalidResponse",
		backendChangedCode: "provider_credential_profile_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "provider_credential_profile_transport_failed",
		requestFailedMessage: "ipc.dureRun.requestFailed",
	});
	const response = await backendRequest(
		"provider_credential_profile.register",
		{
			schemaVersion: 1,
			...request,
		},
		options?.routeAuthority
			? { kind: "exact", authority: options.routeAuthority }
			: undefined,
	);
	const profile = record(response.result.profile);
	if (
		response.result.schemaVersion !== 1 ||
		!profile ||
		profile.schemaVersion !== 1 ||
		profile.providerId !== request.providerId ||
		profile.referenceId !== request.referenceId ||
		!isDureDomainIdV1(profile.credentialGeneration)
	) {
		throw contractError();
	}
	return {
		kind: "credential_reference",
		reference_id: request.referenceId,
		credential_generation: profile.credentialGeneration,
	};
}
