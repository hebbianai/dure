import {
	createDureBackendRequester,
	DureBackendAuthorityFence,
	type DureBackendIdentity,
	type DureBackendInvoke,
	resolveSelectedDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackend";
import { asRecord as record } from "@/lib/payloadGuards";
import type {
	ProviderLaunchDefaultsDocumentV1,
	ProviderLaunchDefaultsProjectionV1,
	ProviderLaunchDefaultsPutDispositionV1,
	ProviderLaunchDefaultsPutReceiptV1,
	ProviderLaunchDefaultsTransport,
	ProviderLaunchPermissionModeV1,
} from "@/lib/settings/providerLaunchDefaultsContract";
import { useStore } from "@/store";
import type { Provider } from "@/types";

export type {
	ProviderLaunchDefaultsDocumentV1,
	ProviderLaunchDefaultsProjectionV1,
	ProviderLaunchDefaultsTransport,
} from "@/lib/settings/providerLaunchDefaultsContract";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROVIDER_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

class ProviderLaunchDefaultsError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "ProviderLaunchDefaultsError";
	}
}

function onlyKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function safeRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sameDefaults(
	left: ProviderLaunchDefaultsDocumentV1["defaults"],
	right: ProviderLaunchDefaultsDocumentV1["defaults"],
): boolean {
	const leftProviders = Object.keys(left).sort();
	const rightProviders = Object.keys(right).sort();
	return (
		leftProviders.length === rightProviders.length &&
		leftProviders.every(
			(providerId, index) =>
				providerId === rightProviders[index] &&
				left[providerId]?.permissionMode === right[providerId]?.permissionMode,
		)
	);
}

function parseDocument(value: unknown): ProviderLaunchDefaultsDocumentV1 {
	const document = record(value);
	const defaults = record(document?.defaults);
	if (
		!document ||
		!defaults ||
		!onlyKeys(document, [
			"schemaVersion",
			"revision",
			"defaults",
			"fingerprint",
		]) ||
		document.schemaVersion !== 1 ||
		!safeRevision(document.revision) ||
		!SHA256.test(String(document.fingerprint ?? ""))
	) {
		throw new ProviderLaunchDefaultsError(
			"provider_launch_defaults_malformed",
			"Dure backend returned a malformed provider launch defaults document.",
		);
	}
	const parsedDefaults: ProviderLaunchDefaultsDocumentV1["defaults"] = {};
	if (Object.keys(defaults).length > 64) {
		throw new ProviderLaunchDefaultsError(
			"provider_launch_defaults_malformed",
			"Dure backend returned too many provider launch defaults.",
		);
	}
	for (const [providerId, rawEntry] of Object.entries(defaults)) {
		const entry = record(rawEntry);
		if (
			providerId.length > 128 ||
			!PROVIDER_ID.test(providerId) ||
			!entry ||
			!onlyKeys(entry, ["permissionMode"]) ||
			!["require_approvals", "bypass_approvals"].includes(
				String(entry.permissionMode),
			)
		) {
			throw new ProviderLaunchDefaultsError(
				"provider_launch_defaults_malformed",
				"Dure backend returned a malformed provider launch default.",
			);
		}
		parsedDefaults[providerId] = {
			permissionMode: entry.permissionMode as ProviderLaunchPermissionModeV1,
		};
	}
	return {
		schemaVersion: 1,
		revision: document.revision,
		defaults: parsedDefaults,
		fingerprint: document.fingerprint as string,
	};
}

function invalidResponse(): ProviderLaunchDefaultsError {
	return new ProviderLaunchDefaultsError(
		"provider_launch_defaults_response_invalid",
		"Dure backend returned an invalid provider launch defaults response.",
	);
}

function parseReceipt(
	value: unknown,
	expected: {
		idempotencyKey: string;
		expectedRevision: number;
		defaults: ProviderLaunchDefaultsDocumentV1["defaults"];
	},
): ProviderLaunchDefaultsPutReceiptV1 {
	const receipt = record(value);
	if (
		!receipt ||
		!onlyKeys(receipt, [
			"schemaVersion",
			"idempotencyKey",
			"expectedRevision",
			"disposition",
			"document",
			"updatedAtMs",
		]) ||
		receipt.schemaVersion !== 1 ||
		receipt.idempotencyKey !== expected.idempotencyKey ||
		receipt.expectedRevision !== expected.expectedRevision ||
		!["created", "updated", "preserved_existing"].includes(
			String(receipt.disposition),
		) ||
		!Number.isSafeInteger(receipt.updatedAtMs) ||
		Number(receipt.updatedAtMs) < 0
	) {
		throw invalidResponse();
	}
	const document = parseDocument(receipt.document);
	const revisionMatches =
		(receipt.disposition === "created" &&
			receipt.expectedRevision === 0 &&
			document.revision === 1) ||
		(receipt.disposition === "updated" &&
			document.revision === Number(receipt.expectedRevision) + 1) ||
		(receipt.disposition === "preserved_existing" &&
			receipt.expectedRevision === 0 &&
			document.revision > 0);
	const exactWrite =
		receipt.disposition === "created" || receipt.disposition === "updated";
	if (
		!revisionMatches ||
		(exactWrite && !sameDefaults(document.defaults, expected.defaults))
	) {
		throw invalidResponse();
	}
	return {
		schemaVersion: 1,
		idempotencyKey: receipt.idempotencyKey,
		expectedRevision: receipt.expectedRevision,
		disposition: receipt.disposition as ProviderLaunchDefaultsPutDispositionV1,
		document,
		updatedAtMs: receipt.updatedAtMs as number,
	};
}

function asTypedFailure(error: unknown): ProviderLaunchDefaultsError {
	if (error instanceof ProviderLaunchDefaultsError) return error;
	const candidate = record(error);
	return new ProviderLaunchDefaultsError(
		typeof candidate?.code === "string"
			? candidate.code
			: "provider_launch_defaults_unavailable",
		"Dure provider launch defaults are unavailable.",
		error,
	);
}

export function createProviderLaunchDefaultsTransport(options?: {
	profileId?: string;
	invokeCommand?: DureBackendInvoke;
	expectedBackend?: DureBackendIdentity;
}): ProviderLaunchDefaultsTransport {
	const profileId = options?.profileId ?? "local";
	const backendAuthority = new DureBackendAuthorityFence();
	const backendRequest = createDureBackendRequester({
		profileId,
		invokeCommand: options?.invokeCommand,
		invalidResponseCode: "provider_launch_defaults_response_invalid",
		invalidResponseMessage:
			"Dure backend returned an invalid provider launch defaults response.",
		backendChangedCode: "provider_launch_defaults_backend_changed",
		backendChangedMessage:
			"Dure backend changed while provider launch defaults were being updated.",
		requestFailedCode: "provider_launch_defaults_transport_failed",
		requestFailedMessage:
			"The provider launch defaults request could not reach the Dure backend.",
		authority: backendAuthority,
	});
	const assertExpectedBackend = (backend: DureBackendIdentity) => {
		if (
			options?.expectedBackend &&
			(options.expectedBackend.id !== backend.id ||
				options.expectedBackend.generation !== backend.generation)
		) {
			throw new ProviderLaunchDefaultsError(
				"provider_launch_defaults_backend_changed",
				"Dure backend changed while provider launch defaults were being updated.",
			);
		}
	};
	return {
		async get() {
			try {
				const response = await backendRequest(
					"provider_launch_defaults.get",
					{ schemaVersion: 1 },
					{ kind: "complete_selected_snapshot" },
				);
				if (
					!onlyKeys(response.result, ["schemaVersion", "document"]) ||
					response.result.schemaVersion !== 1
				) {
					throw invalidResponse();
				}
				assertExpectedBackend(response.backend);
				return {
					backend: response.backend,
					document: parseDocument(response.result.document),
				};
			} catch (error) {
				throw asTypedFailure(error);
			}
		},
		async put(request) {
			if (
				!TOKEN.test(request.idempotencyKey) ||
				!safeRevision(request.expectedRevision)
			) {
				throw new ProviderLaunchDefaultsError(
					"provider_launch_defaults_request_invalid",
					"Provider launch defaults write input is invalid.",
				);
			}
			try {
				const routeAuthority =
					backendAuthority.currentRouteAuthority() ??
					(await resolveSelectedDureBackendRouteAuthority(
						profileId,
						options?.invokeCommand,
					));
				assertExpectedBackend(routeAuthority.backend);
				const response = await backendRequest(
					"provider_launch_defaults.put",
					{
						schemaVersion: 1,
						idempotencyKey: request.idempotencyKey,
						expectedRevision: request.expectedRevision,
						defaults: request.defaults,
					},
					{ kind: "exact", authority: routeAuthority },
				);
				if (
					!onlyKeys(response.result, ["schemaVersion", "receipt"]) ||
					response.result.schemaVersion !== 1
				) {
					throw invalidResponse();
				}
				assertExpectedBackend(response.backend);
				return {
					backend: response.backend,
					receipt: parseReceipt(response.result.receipt, request),
				};
			} catch (error) {
				throw asTypedFailure(error);
			}
		},
	};
}

const synchronizationByProfile = new Map<string, Promise<void>>();

function legacyDefaults(
	legacy: Partial<Record<Provider, boolean>>,
): ProviderLaunchDefaultsDocumentV1["defaults"] {
	return Object.fromEntries(
		Object.entries(legacy).map(([providerId, bypass]) => [
			providerId,
			{
				permissionMode: bypass ? "bypass_approvals" : "require_approvals",
			},
		]),
	) as ProviderLaunchDefaultsDocumentV1["defaults"];
}

async function legacyMigrationIdempotencyKey(
	defaults: ProviderLaunchDefaultsDocumentV1["defaults"],
): Promise<string> {
	const canonical = JSON.stringify(
		Object.fromEntries(
			Object.entries(defaults).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	);
	const digest = new Uint8Array(
		await globalThis.crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(canonical),
		),
	);
	return `frontend-provider-defaults-v1:${[...digest]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("")}`;
}

export async function synchronizeProviderLaunchDefaults(
	profileId = "local",
): Promise<void> {
	const existing = synchronizationByProfile.get(profileId);
	if (existing) return existing;
	const synchronization = (async () => {
		const transport = createProviderLaunchDefaultsTransport({ profileId });
		const legacy = useStore.getState().legacySkipPermissions;
		const projection = await loadProviderLaunchDefaultsProjection(
			legacy,
			transport,
		);
		useStore
			.getState()
			.applyProviderLaunchDefaultsProjection(
				projection.document,
				projection.backend,
				profileId,
			);
	})();
	synchronizationByProfile.set(profileId, synchronization);
	try {
		await synchronization;
	} catch (error) {
		const failure = asTypedFailure(error);
		useStore.setState({ providerLaunchDefaultsError: failure.code });
		throw failure;
	} finally {
		synchronizationByProfile.delete(profileId);
	}
}

export async function ensureProviderLaunchDefaultsProjection(
	profileId = "local",
): Promise<void> {
	await synchronizeProviderLaunchDefaults(profileId);
}

export async function loadProviderLaunchDefaultsProjection(
	legacy: Partial<Record<Provider, boolean>> | undefined,
	transport: ProviderLaunchDefaultsTransport,
): Promise<ProviderLaunchDefaultsProjectionV1> {
	if (!legacy) return transport.get();
	const defaults = legacyDefaults(legacy);
	const migrated = await transport.put({
		idempotencyKey: await legacyMigrationIdempotencyKey(defaults),
		expectedRevision: 0,
		defaults,
	});
	const projection = await transport.get();
	if (
		projection.backend.id !== migrated.backend.id ||
		projection.backend.generation !== migrated.backend.generation
	) {
		throw new ProviderLaunchDefaultsError(
			"provider_launch_defaults_backend_changed",
			"Dure backend changed while legacy provider defaults were being migrated.",
		);
	}
	return projection;
}

function updateIdempotencyKey(): string {
	const nonce =
		globalThis.crypto?.randomUUID?.().replace(/-/g, "") ??
		`${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
	return `provider-defaults-ui:${nonce}`;
}

export async function updateProviderLaunchPermissionDefault(
	provider: Provider,
	bypass: boolean,
	profileId = "local",
): Promise<void> {
	try {
		await synchronizeProviderLaunchDefaults(profileId);
		const state = useStore.getState();
		const expectedBackend = state.providerLaunchDefaultsBackend;
		if (!state.providerLaunchDefaults || !expectedBackend) {
			throw new ProviderLaunchDefaultsError(
				"provider_launch_defaults_unavailable",
				"Provider launch defaults have not been projected.",
			);
		}
		if (state.providerLaunchDefaultsProfileId !== profileId) {
			throw new ProviderLaunchDefaultsError(
				"provider_launch_defaults_backend_changed",
				"The selected Dure backend changed before provider defaults could be updated.",
			);
		}
		const transport = createProviderLaunchDefaultsTransport({
			profileId,
			expectedBackend,
		});
		const projection = await transport.get();
		useStore
			.getState()
			.applyProviderLaunchDefaultsProjection(
				projection.document,
				projection.backend,
				profileId,
			);
		const current = projection.document;
		const defaults = {
			...current.defaults,
			[provider]: {
				permissionMode: bypass ? "bypass_approvals" : "require_approvals",
			} satisfies { permissionMode: ProviderLaunchPermissionModeV1 },
		};
		const { backend, receipt } = await transport.put({
			idempotencyKey: updateIdempotencyKey(),
			expectedRevision: current.revision,
			defaults,
		});
		useStore
			.getState()
			.applyProviderLaunchDefaultsProjection(
				receipt.document,
				backend,
				profileId,
			);
		if (
			receipt.document.defaults[provider]?.permissionMode !==
			defaults[provider].permissionMode
		) {
			throw new ProviderLaunchDefaultsError(
				"provider_launch_defaults_revision_conflict",
				"Provider launch defaults changed before the update committed.",
			);
		}
	} catch (error) {
		const failure = asTypedFailure(error);
		useStore.setState({ providerLaunchDefaultsError: failure.code });
		throw failure;
	}
}

export function installProviderLaunchDefaultsProjection(): () => void {
	let disposed = false;
	const refresh = () => {
		if (disposed || document.visibilityState === "hidden") return;
		void synchronizeProviderLaunchDefaults().catch((error) => {
			if (!disposed) console.warn("[provider launch defaults]", error);
		});
	};
	refresh();
	window.addEventListener("focus", refresh);
	document.addEventListener("visibilitychange", refresh);
	return () => {
		disposed = true;
		window.removeEventListener("focus", refresh);
		document.removeEventListener("visibilitychange", refresh);
	};
}
