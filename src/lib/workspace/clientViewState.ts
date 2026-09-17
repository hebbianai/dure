export interface ClientViewNamespaceV1 {
	tenantId: string;
	userId: string;
	clientId: string;
}

export interface ClientViewAuthorityV1 {
	schemaVersion: 1;
	namespace: ClientViewNamespaceV1;
	clientGeneration: number;
	clientInstanceId: string;
	updatedAtMs: number;
}

export interface ClientViewIdentityV1 {
	namespace: ClientViewNamespaceV1;
	clientGeneration: number;
	clientInstanceId: string;
	viewId: string;
}

export interface ClientViewLayoutSlotV1 {
	paneId: string;
	groupId: string;
	order: number;
	sizeBasisPoints: number;
}

interface ClientViewViewportV1 {
	paneId: string;
	anchorSequence: number | null;
	scrollOffsetRows: number;
}

interface ClientViewFilterV1 {
	filterId: string;
	enabled: boolean;
}

interface ClientViewSubscriptionV1 {
	topic: "agent_activity" | "session_output" | "workspace_changes";
	resourceId: string;
}

export interface ClientViewPresentationV1 {
	selectedSessionId: string | null;
	selectedSpaceId: string | null;
	selectedPaneId: string | null;
	layout: ClientViewLayoutSlotV1[];
	viewports: ClientViewViewportV1[];
	filters: ClientViewFilterV1[];
	subscriptions: ClientViewSubscriptionV1[];
}

export interface ClientViewRecordV1 {
	schemaVersion: 1;
	identity: ClientViewIdentityV1;
	revision: number;
	presentation: ClientViewPresentationV1;
	updatedAtMs: number;
}

export interface ClientViewGenerationAdvanceRequestV1 {
	schemaVersion: 1;
	namespace: ClientViewNamespaceV1;
	idempotencyKey: string;
	expectedGeneration: number;
	expectedInstanceId?: string;
	nextInstanceId: string;
}

export interface ClientViewGenerationReceiptV1 {
	schemaVersion: 1;
	idempotencyKey: string;
	authority: ClientViewAuthorityV1;
}

export interface ClientViewWriteRequestV1 {
	schemaVersion: 1;
	identity: ClientViewIdentityV1;
	idempotencyKey: string;
	expectedRevision: number;
	presentation: ClientViewPresentationV1;
}

export interface ClientViewWriteReceiptV1 {
	schemaVersion: 1;
	idempotencyKey: string;
	record: ClientViewRecordV1;
}

export type ClientViewTransportError =
	| { kind: "unavailable"; message: string }
	| { kind: "backend_changed"; message: string }
	| { kind: "revision_conflict"; actualRevision: number; message: string }
	| { kind: "generation_conflict"; actualGeneration: number; message: string }
	| { kind: "instance_conflict"; message: string }
	| {
			kind: "invalid" | "idempotency_conflict" | "unsupported" | "fatal";
			message: string;
	  };

export type ClientViewTransportResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: ClientViewTransportError };

export interface ClientViewStateTransport {
	readAuthority(
		namespace: ClientViewNamespaceV1,
	): Promise<ClientViewTransportResult<ClientViewAuthorityV1 | null>>;
	advanceGeneration(
		request: ClientViewGenerationAdvanceRequestV1,
	): Promise<ClientViewTransportResult<ClientViewGenerationReceiptV1>>;
	readView(
		identity: ClientViewIdentityV1,
	): Promise<ClientViewTransportResult<ClientViewRecordV1 | null>>;
	writeView(
		request: ClientViewWriteRequestV1,
	): Promise<ClientViewTransportResult<ClientViewWriteReceiptV1>>;
}

export type ClientViewPresentationField = keyof ClientViewPresentationV1;

export const EMPTY_CLIENT_VIEW_PRESENTATION_V1: ClientViewPresentationV1 = {
	selectedSessionId: null,
	selectedSpaceId: null,
	selectedPaneId: null,
	layout: [],
	viewports: [],
	filters: [],
	subscriptions: [],
};

const PRESENTATION_FIELDS: ClientViewPresentationField[] = [
	"selectedSessionId",
	"selectedSpaceId",
	"selectedPaneId",
	"layout",
	"viewports",
	"filters",
	"subscriptions",
];

export function cloneClientViewNamespace(
	value: ClientViewNamespaceV1,
): ClientViewNamespaceV1 {
	return {
		tenantId: value.tenantId,
		userId: value.userId,
		clientId: value.clientId,
	};
}

export function cloneClientViewPresentation(
	value: ClientViewPresentationV1,
): ClientViewPresentationV1 {
	return {
		selectedSessionId: value.selectedSessionId ?? null,
		selectedSpaceId: value.selectedSpaceId ?? null,
		selectedPaneId: value.selectedPaneId ?? null,
		layout: value.layout.map(({ paneId, groupId, order, sizeBasisPoints }) => ({
			paneId,
			groupId,
			order,
			sizeBasisPoints,
		})),
		viewports: value.viewports.map(
			({ paneId, anchorSequence, scrollOffsetRows }) => ({
				paneId,
				anchorSequence: anchorSequence ?? null,
				scrollOffsetRows,
			}),
		),
		filters: value.filters.map(({ filterId, enabled }) => ({
			filterId,
			enabled,
		})),
		subscriptions: value.subscriptions.map(({ topic, resourceId }) => ({
			topic,
			resourceId,
		})),
	};
}

export function clientViewPresentationsEqual(
	left: ClientViewPresentationV1,
	right: ClientViewPresentationV1,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function clientViewNamespacesEqual(
	left: ClientViewNamespaceV1,
	right: ClientViewNamespaceV1,
): boolean {
	return (
		left.tenantId === right.tenantId &&
		left.userId === right.userId &&
		left.clientId === right.clientId
	);
}

export function clientViewIdentitiesEqual(
	left: ClientViewIdentityV1,
	right: ClientViewIdentityV1,
): boolean {
	return (
		clientViewNamespacesEqual(left.namespace, right.namespace) &&
		left.clientGeneration === right.clientGeneration &&
		left.clientInstanceId === right.clientInstanceId &&
		left.viewId === right.viewId
	);
}

function valuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeClientViewPresentations(
	base: ClientViewPresentationV1,
	local: ClientViewPresentationV1,
	remote: ClientViewPresentationV1,
): {
	presentation: ClientViewPresentationV1;
	conflictingFields: ClientViewPresentationField[];
} {
	const presentation = cloneClientViewPresentation(remote);
	const conflictingFields: ClientViewPresentationField[] = [];
	const writable = presentation as unknown as Record<string, unknown>;
	const baseRecord = base as unknown as Record<string, unknown>;
	const localRecord = local as unknown as Record<string, unknown>;
	const remoteRecord = remote as unknown as Record<string, unknown>;
	for (const field of PRESENTATION_FIELDS) {
		const localChanged = !valuesEqual(localRecord[field], baseRecord[field]);
		const remoteChanged = !valuesEqual(remoteRecord[field], baseRecord[field]);
		if (
			localChanged &&
			remoteChanged &&
			!valuesEqual(localRecord[field], remoteRecord[field])
		) {
			conflictingFields.push(field);
			continue;
		}
		if (localChanged) writable[field] = localRecord[field];
	}
	return {
		presentation: cloneClientViewPresentation(presentation),
		conflictingFields,
	};
}
