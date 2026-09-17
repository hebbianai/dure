import type { ObservedProviderModelV1 } from "@/lib/agents/providerModels";
import { parseProviderModels } from "@/lib/agents/providerModels";
import { createDureBackendRequester } from "@/lib/ipc/dureBackend";

export interface ProviderCatalogRequest {
	providerId: string;
	profileId: string;
	credentialProfile?: { referenceId: string; profileDirectoryName: string };
}

export async function readProviderCatalog(
	request: ProviderCatalogRequest,
): Promise<readonly ObservedProviderModelV1[]> {
	const backend = createDureBackendRequester({
		profileId: request.profileId,
		invalidResponseCode: "provider_catalog_response_invalid",
		invalidResponseMessage: "ipc.dureRun.invalidResponse",
		backendChangedCode: "provider_catalog_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "provider_catalog_transport_failed",
		requestFailedMessage: "ipc.dureRun.requestFailed",
	});
	const response = await backend(
		"provider_catalog.read",
		{
			schemaVersion: 1,
			providerId: request.providerId,
			credentialProfile: request.credentialProfile ?? null,
		},
		{ kind: "complete_selected_snapshot" },
	);
	const models = parseProviderModels(response.result.models);
	if (!models) throw new Error("provider_catalog_response_invalid");
	return models;
}
