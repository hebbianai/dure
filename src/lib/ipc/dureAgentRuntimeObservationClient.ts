import type {
	DureAgentRuntimeInspectResultV1,
	DureAgentRuntimeProjectionInspectResultV1,
} from "@/lib/ipc/dureAgentRuntimeTypes";
import type {
	createDureBackendRequester,
	DureBackendRequestRouteV1,
	DureBackendResponse,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { isDureDomainIdV1 } from "@/lib/ipc/dureProtocolIdentity";
import {
	agentRuntimeHibernateBody,
	agentRuntimeWakeBody,
	type RuntimeHibernateIntent,
} from "../../../cli/lib/contracts/agent-runtime.mjs";

export interface DureAgentRuntimeObservationClient {
	hibernate(
		request: RuntimeHibernateIntent & {
			routeAuthority: DureBackendRouteAuthorityV1;
		},
	): Promise<DureAgentRuntimeProjectionInspectResultV1>;
	wake(
		request: Extract<DureAgentRuntimeInspectResultV1, { state: "dormant" }>,
		expectedProviderConversationRef?: string,
	): Promise<DureAgentRuntimeProjectionInspectResultV1>;
	inspect(agentId: string): Promise<DureAgentRuntimeProjectionInspectResultV1>;
	inspectExact(
		agentId: string,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<DureAgentRuntimeProjectionInspectResultV1>;
}

/** Observation and deferred lifecycle share the same carrier/parser. Reading
 * a dormant runtime never grants wake authority or launches a provider. */
export function createRuntimeObservationClient({
	profileId,
	request,
	parse,
	invalid,
	normalizeError,
}: {
	profileId: string;
	request: ReturnType<typeof createDureBackendRequester>;
	parse(
		response: DureBackendResponse,
		agentId: string,
	): DureAgentRuntimeProjectionInspectResultV1;
	invalid(): Error;
	normalizeError(error: unknown): unknown;
}): DureAgentRuntimeObservationClient {
	async function observe(
		operation: string,
		body: Record<string, unknown> & { schemaVersion: 1; agentId: string },
		route: DureBackendRequestRouteV1,
	) {
		if (route.kind === "exact" && route.authority.profileId !== profileId)
			throw invalid();
		const response = await request(operation, body, route);
		return parse(response, body.agentId);
	}
	async function inspect(agentId: string, route: DureBackendRequestRouteV1) {
		if (!isDureDomainIdV1(agentId)) throw invalid();
		return observe(
			"agent_runtime.projection.inspect",
			{ schemaVersion: 1, agentId },
			route,
		);
	}
	function mutate(...args: Parameters<typeof observe>) {
		return observe(...args).catch((error: unknown) => {
			throw normalizeError(error);
		});
	}
	return {
		inspect: (agentId) =>
			inspect(agentId, { kind: "complete_selected_snapshot" }),
		inspectExact: (agentId, authority) =>
			inspect(agentId, { kind: "exact", authority }),
		hibernate: async ({ agentId, expectedSourceRevision, routeAuthority }) => {
			const body = agentRuntimeHibernateBody({
				agentId,
				expectedSourceRevision,
			});
			if (!body) throw invalid();
			return mutate(
				"agent_runtime.hibernate",
				{ ...body },
				{ kind: "exact", authority: routeAuthority },
			);
		},
		wake: async (source, expectedProviderConversationRef) => {
			if (source.state !== "dormant" || source.stage !== "source_stopped")
				throw invalid();
			const body = agentRuntimeWakeBody({
				agentId: source.agentId,
				operationId: source.operationId,
				expectedJournalRevision: source.journalRevision,
				expectedProviderConversationRef,
			});
			if (!body) throw invalid();
			return mutate(
				"agent_runtime.wake",
				{ ...body },
				{ kind: "exact", authority: source.routeAuthority },
			);
		},
	};
}
