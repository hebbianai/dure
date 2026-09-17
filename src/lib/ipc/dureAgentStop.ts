import {
	type CanonicalAgentStopReceiptV1,
	parseCanonicalAgentStopResultV1,
} from "@/lib/agents/canonicalAgentStopLifecycle";
import { t } from "@/lib/i18n";
import {
	createDureBackendRequester,
	DureBackendAuthorityFence,
	type DureBackendInvoke,
	DureBackendRequestError,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	isDureBackendProfileIdV1,
	isDureDomainIdV1,
} from "@/lib/ipc/dureProtocolIdentity";

interface DureAgentStopObservationV1 {
	readonly receipt: CanonicalAgentStopReceiptV1 | null;
	readonly routeAuthority: DureBackendRouteAuthorityV1;
}

export interface DureAgentStopClient {
	status(spawnOperationId: string): Promise<DureAgentStopObservationV1>;
	preview(
		spawnOperationId: string,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<CanonicalAgentStopReceiptV1>;
	apply(
		receipt: CanonicalAgentStopReceiptV1,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<CanonicalAgentStopReceiptV1>;
}

function contractError(code = "agent_dispatch_stop_response_invalid") {
	return new DureBackendRequestError(code, t("agents.remove.cleanupUnsafe"), {
		kind: "contract",
	});
}

function parsedReceipt(
	value: unknown,
	spawnOperationId: string,
): CanonicalAgentStopReceiptV1 | null {
	const receipt = parseCanonicalAgentStopResultV1(value, spawnOperationId);
	if (receipt === undefined) throw contractError();
	return receipt;
}

function exactReceipt(
	value: unknown,
	expected: CanonicalAgentStopReceiptV1,
): CanonicalAgentStopReceiptV1 {
	const receipt = parsedReceipt(value, expected.spawnOperationId);
	if (
		!receipt ||
		receipt.operationId !== expected.operationId ||
		receipt.planToken !== expected.planToken ||
		receipt.agentId !== expected.agentId ||
		receipt.workspaceDisposition !== expected.workspaceDisposition
	) {
		throw contractError();
	}
	return receipt;
}

function expectedApplyRevision(receipt: CanonicalAgentStopReceiptV1): number {
	if (receipt.status === "planned") return receipt.journalRevision;
	if (receipt.status === "authorized" && receipt.journalRevision > 1) {
		return receipt.journalRevision - 1;
	}
	throw contractError("agent_dispatch_stop_not_applicable");
}

export function createDureAgentStopClient(options: {
	profileId: string;
	invokeCommand?: DureBackendInvoke;
}): DureAgentStopClient {
	if (!isDureBackendProfileIdV1(options.profileId)) throw contractError();
	const authority = new DureBackendAuthorityFence();
	const backendRequest = createDureBackendRequester({
		profileId: options.profileId,
		invokeCommand: options.invokeCommand,
		invalidResponseCode: "agent_dispatch_stop_response_invalid",
		invalidResponseMessage: "agents.remove.cleanupUnsafe",
		backendChangedCode: "agent_dispatch_stop_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "agent_dispatch_stop_transport_failed",
		requestFailedMessage: "agents.remove.cleanupUnsafe",
		authority,
	});

	return {
		async status(spawnOperationId) {
			if (!isDureDomainIdV1(spawnOperationId)) throw contractError();
			const response = await backendRequest(
				"dispatch.stop.status",
				{ schemaVersion: 1, spawnOperationId },
				{ kind: "complete_selected_snapshot" },
			);
			return {
				receipt: parsedReceipt(response.result, spawnOperationId),
				routeAuthority: response.routeAuthority,
			};
		},
		async preview(spawnOperationId, routeAuthority) {
			if (
				!isDureDomainIdV1(spawnOperationId) ||
				routeAuthority.profileId !== options.profileId
			) {
				throw contractError("agent_dispatch_stop_request_invalid");
			}
			const response = await backendRequest(
				"dispatch.stop.preview",
				{
					schemaVersion: 1,
					spawnOperationId,
					workspaceDisposition: "preserve",
				},
				{ kind: "exact", authority: routeAuthority },
			);
			const receipt = parsedReceipt(response.result, spawnOperationId);
			if (receipt?.workspaceDisposition !== "preserve") {
				throw contractError();
			}
			return receipt;
		},
		async apply(receipt, routeAuthority) {
			if (routeAuthority.profileId !== options.profileId) {
				throw contractError("agent_dispatch_stop_request_invalid");
			}
			const response = await backendRequest(
				"dispatch.stop.apply",
				{
					schemaVersion: 1,
					operationId: receipt.operationId,
					planToken: receipt.planToken,
					expectedJournalRevision: expectedApplyRevision(receipt),
				},
				{ kind: "exact", authority: routeAuthority },
			);
			return exactReceipt(response.result, receipt);
		},
	};
}
