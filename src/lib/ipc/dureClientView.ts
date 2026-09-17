import { validClientViewToken as viewToken } from "@/lib/ipc/clientViewToken";
import {
	createDureBackendRequester,
	DureBackendAuthorityFence,
	type DureBackendInvoke,
	type DureBackendRequestRouteV1,
	resolveSelectedDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackend";
import {
	isRecord,
	nonNegativeInteger as safeInteger,
	positiveInteger,
} from "@/lib/payloadGuards";
import type {
	ClientViewAuthorityV1,
	ClientViewGenerationAdvanceRequestV1,
	ClientViewGenerationReceiptV1,
	ClientViewIdentityV1,
	ClientViewNamespaceV1,
	ClientViewRecordV1,
	ClientViewStateTransport,
	ClientViewTransportError,
	ClientViewTransportResult,
	ClientViewWriteReceiptV1,
	ClientViewWriteRequestV1,
} from "@/lib/workspace/clientViewState";

interface BackendErrorEnvelope {
	code?: unknown;
	message?: unknown;
	details?: unknown;
}

type Parsed<T> = { valid: true; value: T } | { valid: false };

const invalidParsed: Parsed<never> = { valid: false };
const CLIENT_VIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9._:-]{1,160}$/;

export interface DureClientViewTransportOptions {
	profileId?: string;
	invokeCommand?: DureBackendInvoke;
}

function opaqueToken(value: unknown): value is string {
	return typeof value === "string" && OPAQUE_TOKEN.test(value);
}

function clientViewId(value: unknown): value is string {
	return typeof value === "string" && CLIENT_VIEW_ID.test(value);
}

function namespaceValue(value: unknown): ClientViewNamespaceV1 | null {
	if (!isRecord(value)) return null;
	return clientViewId(value.tenantId) &&
		clientViewId(value.userId) &&
		clientViewId(value.clientId)
		? {
				tenantId: value.tenantId,
				userId: value.userId,
				clientId: value.clientId,
			}
		: null;
}

function authorityValue(value: unknown): Parsed<ClientViewAuthorityV1> {
	if (!isRecord(value)) return invalidParsed;
	const namespace = namespaceValue(value.namespace);
	if (
		value.schemaVersion !== 1 ||
		!namespace ||
		!positiveInteger(value.clientGeneration) ||
		!clientViewId(value.clientInstanceId) ||
		!safeInteger(value.updatedAtMs)
	) {
		return invalidParsed;
	}
	return {
		valid: true,
		value: {
			schemaVersion: 1,
			namespace,
			clientGeneration: value.clientGeneration,
			clientInstanceId: value.clientInstanceId,
			updatedAtMs: value.updatedAtMs,
		},
	};
}

function identityValue(value: unknown): ClientViewIdentityV1 | null {
	if (!isRecord(value)) return null;
	const namespace = namespaceValue(value.namespace);
	return namespace &&
		positiveInteger(value.clientGeneration) &&
		clientViewId(value.clientInstanceId) &&
		clientViewId(value.viewId)
		? {
				namespace,
				clientGeneration: value.clientGeneration,
				clientInstanceId: value.clientInstanceId,
				viewId: value.viewId,
			}
		: null;
}

function presentationValue(
	value: unknown,
): ClientViewRecordV1["presentation"] | null {
	if (!isRecord(value)) return null;
	for (const selected of [
		value.selectedSessionId,
		value.selectedSpaceId,
		value.selectedPaneId,
	]) {
		if (selected !== null && !viewToken(selected)) return null;
	}
	if (
		!Array.isArray(value.layout) ||
		value.layout.length > 128 ||
		!Array.isArray(value.viewports) ||
		value.viewports.length > 128 ||
		!Array.isArray(value.filters) ||
		value.filters.length > 64 ||
		!Array.isArray(value.subscriptions) ||
		value.subscriptions.length > 128
	) {
		return null;
	}
	const paneIds = new Set<string>();
	const groupOrders = new Set<string>();
	const layout = value.layout.flatMap((entry) => {
		if (
			!isRecord(entry) ||
			!viewToken(entry.paneId) ||
			!viewToken(entry.groupId) ||
			!safeInteger(entry.order) ||
			entry.order > 65_535 ||
			!positiveInteger(entry.sizeBasisPoints) ||
			entry.sizeBasisPoints > 10_000 ||
			paneIds.has(entry.paneId) ||
			groupOrders.has(`${entry.groupId}\u0000${entry.order}`)
		) {
			return [];
		}
		paneIds.add(entry.paneId);
		groupOrders.add(`${entry.groupId}\u0000${entry.order}`);
		return [
			{
				paneId: entry.paneId,
				groupId: entry.groupId,
				order: entry.order,
				sizeBasisPoints: entry.sizeBasisPoints,
			},
		];
	});
	if (layout.length !== value.layout.length) return null;
	const viewportPanes = new Set<string>();
	const viewports = value.viewports.flatMap((entry) => {
		if (
			!isRecord(entry) ||
			!viewToken(entry.paneId) ||
			(entry.anchorSequence !== null && !safeInteger(entry.anchorSequence)) ||
			!Number.isSafeInteger(entry.scrollOffsetRows) ||
			Math.abs(Number(entry.scrollOffsetRows)) > 1_000_000 ||
			viewportPanes.has(entry.paneId)
		) {
			return [];
		}
		viewportPanes.add(entry.paneId);
		return [
			{
				paneId: entry.paneId,
				anchorSequence: entry.anchorSequence as number | null,
				scrollOffsetRows: entry.scrollOffsetRows as number,
			},
		];
	});
	if (viewports.length !== value.viewports.length) return null;
	const filterIds = new Set<string>();
	const filters = value.filters.flatMap((entry) => {
		if (
			!isRecord(entry) ||
			!viewToken(entry.filterId) ||
			typeof entry.enabled !== "boolean" ||
			filterIds.has(entry.filterId)
		) {
			return [];
		}
		filterIds.add(entry.filterId);
		return [{ filterId: entry.filterId, enabled: entry.enabled }];
	});
	if (filters.length !== value.filters.length) return null;
	const subscriptionIds = new Set<string>();
	const subscriptions = value.subscriptions.flatMap((entry) => {
		if (
			!isRecord(entry) ||
			!(
				["agent_activity", "session_output", "workspace_changes"] as unknown[]
			).includes(entry.topic) ||
			!viewToken(entry.resourceId)
		) {
			return [];
		}
		const key = `${entry.topic}\u0000${entry.resourceId}`;
		if (subscriptionIds.has(key)) return [];
		subscriptionIds.add(key);
		return [
			{
				topic: entry.topic as
					| "agent_activity"
					| "session_output"
					| "workspace_changes",
				resourceId: entry.resourceId,
			},
		];
	});
	if (subscriptions.length !== value.subscriptions.length) return null;
	const presentation = {
		selectedSessionId: value.selectedSessionId as string | null,
		selectedSpaceId: value.selectedSpaceId as string | null,
		selectedPaneId: value.selectedPaneId as string | null,
		layout,
		viewports,
		filters,
		subscriptions,
	};
	return new TextEncoder().encode(JSON.stringify(presentation)).length <=
		64 * 1024
		? presentation
		: null;
}

function recordValue(value: unknown): Parsed<ClientViewRecordV1> {
	if (!isRecord(value)) return invalidParsed;
	const identity = identityValue(value.identity);
	const presentation = presentationValue(value.presentation);
	if (
		value.schemaVersion !== 1 ||
		!identity ||
		!positiveInteger(value.revision) ||
		!presentation ||
		!safeInteger(value.updatedAtMs)
	) {
		return invalidParsed;
	}
	return {
		valid: true,
		value: {
			schemaVersion: 1,
			identity,
			revision: value.revision,
			presentation,
			updatedAtMs: value.updatedAtMs,
		},
	};
}

function generationReceiptValue(
	value: unknown,
): Parsed<ClientViewGenerationReceiptV1> {
	if (!isRecord(value)) return invalidParsed;
	const authority = authorityValue(value.authority);
	if (
		value.schemaVersion !== 1 ||
		!opaqueToken(value.idempotencyKey) ||
		!authority.valid
	) {
		return invalidParsed;
	}
	return {
		valid: true,
		value: {
			schemaVersion: 1,
			idempotencyKey: value.idempotencyKey,
			authority: authority.value,
		},
	};
}

function writeReceiptValue(value: unknown): Parsed<ClientViewWriteReceiptV1> {
	if (!isRecord(value)) return invalidParsed;
	const record = recordValue(value.record);
	if (
		value.schemaVersion !== 1 ||
		!opaqueToken(value.idempotencyKey) ||
		!record.valid
	) {
		return invalidParsed;
	}
	return {
		valid: true,
		value: {
			schemaVersion: 1,
			idempotencyKey: value.idempotencyKey,
			record: record.value,
		},
	};
}

function nullable<T>(parser: (value: unknown) => Parsed<T>) {
	return (value: unknown): Parsed<T | null> =>
		value === null ? { valid: true, value: null } : parser(value);
}

function malformed(): ClientViewTransportResult<never> {
	return {
		ok: false,
		error: {
			kind: "fatal",
			message: "the Dure backend returned a malformed response",
		},
	};
}

function mapBackendError(error: unknown): ClientViewTransportError {
	const envelope = isRecord(error) ? (error as BackendErrorEnvelope) : {};
	const code = typeof envelope.code === "string" ? envelope.code : "";
	const details = isRecord(envelope.details) ? envelope.details : {};
	const message =
		typeof envelope.message === "string" && envelope.message.length > 0
			? envelope.message
			: "the Dure backend request failed";
	if (
		code === "client_view_revision_conflict" &&
		safeInteger(details.actualRevision)
	) {
		return {
			kind: "revision_conflict",
			actualRevision: details.actualRevision,
			message,
		};
	}
	if (
		code === "client_view_generation_conflict" &&
		safeInteger(details.actualGeneration)
	) {
		return {
			kind: "generation_conflict",
			actualGeneration: details.actualGeneration,
			message,
		};
	}
	if (code === "client_view_instance_conflict") {
		return { kind: "instance_conflict", message };
	}
	if (code === "client_view_idempotency_conflict") {
		return { kind: "idempotency_conflict", message };
	}
	if (
		code === "client_view_backend_changed" ||
		code === "backend_transport_authority_changed" ||
		code === "backend_transport_generation_changed"
	) {
		return { kind: "backend_changed", message };
	}
	if (
		code === "client_view_request_invalid" ||
		code === "backend_transport_invalid_request" ||
		code === "backend_transport_request_limit"
	) {
		return { kind: "invalid", message };
	}
	if (
		code === "backend_transport_capability_missing" ||
		code === "backend_transport_operation_unsupported" ||
		code === "backend_operation_unsupported"
	) {
		return { kind: "unsupported", message };
	}
	if (
		code.startsWith("backend_transport_") ||
		code === "backend_busy" ||
		code === "backend_request_deadline_exceeded"
	) {
		return { kind: "unavailable", message };
	}
	return { kind: "fatal", message };
}

function resultValue<T>(
	result: Record<string, unknown>,
	key: string,
	parse: (value: unknown) => Parsed<T>,
): ClientViewTransportResult<T> {
	if (Object.getOwnPropertyDescriptor(result, key) === undefined) {
		return malformed();
	}
	const parsed = parse(result[key]);
	return parsed.valid ? { ok: true, value: parsed.value } : malformed();
}

export function createDureClientViewStateTransport(
	options: DureClientViewTransportOptions = {},
): ClientViewStateTransport {
	const backendAuthority = new DureBackendAuthorityFence();
	const backendRequest = createDureBackendRequester({
		profileId: options.profileId,
		invokeCommand: options.invokeCommand,
		invalidResponseCode: "client_view_response_invalid",
		invalidResponseMessage: "the Dure backend returned a malformed response",
		backendChangedCode: "client_view_backend_changed",
		backendChangedMessage:
			"the Dure backend generation changed; resynchronizing view state",
		requestFailedCode: "client_view_transport_failed",
		requestFailedMessage: "the Dure backend request failed",
		authority: backendAuthority,
	});
	const request = async <T>(
		operation: string,
		body: Record<string, unknown>,
		resultKey: string,
		parse: (value: unknown) => Parsed<T>,
		route?: DureBackendRequestRouteV1 | Promise<DureBackendRequestRouteV1>,
	): Promise<ClientViewTransportResult<T>> => {
		try {
			const response = await backendRequest(operation, body, await route);
			return resultValue(response.result, resultKey, parse);
		} catch (error) {
			return { ok: false, error: mapBackendError(error) };
		}
	};
	const mutationRoute = async (): Promise<DureBackendRequestRouteV1> => ({
		kind: "exact",
		authority:
			backendAuthority.currentRouteAuthority() ??
			(await resolveSelectedDureBackendRouteAuthority(
				options.profileId,
				options.invokeCommand,
			)),
	});
	return {
		readAuthority: (namespace: ClientViewNamespaceV1) =>
			request<ClientViewAuthorityV1 | null>(
				"client_view.authority.read",
				{ schemaVersion: 1, namespace },
				"authority",
				nullable(authorityValue),
				{ kind: "complete_selected_snapshot" },
			),
		advanceGeneration: (body: ClientViewGenerationAdvanceRequestV1) =>
			request<ClientViewGenerationReceiptV1>(
				"client_view.generation.advance",
				body as unknown as Record<string, unknown>,
				"receipt",
				generationReceiptValue,
				mutationRoute(),
			),
		readView: (identity: ClientViewIdentityV1) =>
			request<ClientViewRecordV1 | null>(
				"client_view.read",
				{ schemaVersion: 1, identity },
				"record",
				nullable(recordValue),
				{ kind: "complete_selected_snapshot" },
			),
		writeView: (body: ClientViewWriteRequestV1) =>
			request<ClientViewWriteReceiptV1>(
				"client_view.write",
				body as unknown as Record<string, unknown>,
				"receipt",
				writeReceiptValue,
				mutationRoute(),
			),
	};
}
