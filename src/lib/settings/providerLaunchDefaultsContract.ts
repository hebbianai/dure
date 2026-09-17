import type { DureBackendIdentity } from "@/lib/ipc/dureBackend";

export type ProviderLaunchPermissionModeV1 =
	| "require_approvals"
	| "bypass_approvals";

export interface ProviderLaunchDefaultsDocumentV1 {
	schemaVersion: 1;
	revision: number;
	defaults: Record<string, { permissionMode: ProviderLaunchPermissionModeV1 }>;
	fingerprint: string;
}

export interface ProviderLaunchDefaultsProjectionV1 {
	backend: DureBackendIdentity;
	document: ProviderLaunchDefaultsDocumentV1;
}

export type ProviderLaunchDefaultsPutDispositionV1 =
	| "created"
	| "updated"
	| "preserved_existing";

export interface ProviderLaunchDefaultsPutReceiptV1 {
	schemaVersion: 1;
	idempotencyKey: string;
	expectedRevision: number;
	disposition: ProviderLaunchDefaultsPutDispositionV1;
	document: ProviderLaunchDefaultsDocumentV1;
	updatedAtMs: number;
}

export interface ProviderLaunchDefaultsTransport {
	get(): Promise<{
		backend: DureBackendIdentity;
		document: ProviderLaunchDefaultsDocumentV1;
	}>;
	put(request: {
		idempotencyKey: string;
		expectedRevision: number;
		defaults: ProviderLaunchDefaultsDocumentV1["defaults"];
	}): Promise<{
		backend: DureBackendIdentity;
		receipt: ProviderLaunchDefaultsPutReceiptV1;
	}>;
}
