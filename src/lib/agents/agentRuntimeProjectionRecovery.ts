import { inspectAgentRuntimeProjection } from "@/lib/agents/agentRuntimeProjectionInspection";
import { t } from "@/lib/i18n";
import {
	createDureAgentRuntimeClient,
	type DureAgentRuntimeProjectionInspectResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import {
	DureBackendRequestError,
	resolveSelectedDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackend";
import {
	type DureBackendRouteAuthorityV1,
	sameDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackendRoute";

interface AgentRuntimeProjectionRecoveryDependencies {
	readonly resolveSelectedRoute: (
		profileId: string | undefined,
	) => Promise<DureBackendRouteAuthorityV1>;
	readonly createClient: (
		profileId: string,
	) => Pick<
		ReturnType<typeof createDureAgentRuntimeClient>,
		"inspectExact"
	>;
}

interface AgentRuntimeProjectionRecoveryOptions {
	readonly expectedRouteAuthority?: DureBackendRouteAuthorityV1;
	readonly dependencies?: AgentRuntimeProjectionRecoveryDependencies;
}

const defaultDependencies: AgentRuntimeProjectionRecoveryDependencies = {
	resolveSelectedRoute: resolveSelectedDureBackendRouteAuthority,
	createClient: (profileId) => createDureAgentRuntimeClient({ profileId }),
};

export interface StructuredAgentRuntimeProjectionSourceV1 {
	readonly agentId: string;
	readonly backendProfileId: string;
	readonly interactionSessionId: string;
}

/** Route and runtime identity emitted by the conversation page that requested
 * a projection refresh. The route fences snapshot reuse; a fresh selected
 * snapshot may still supersede it after a backend replacement. */
export interface StructuredAgentRuntimeProjectionGenerationV1 {
	readonly routeAuthority: DureBackendRouteAuthorityV1;
	readonly bindingRevision: number;
	readonly runtimeGeneration: string;
	readonly providerEpoch: string;
}

export function sameStructuredAgentRuntimeProjectionGeneration(
	left: StructuredAgentRuntimeProjectionGenerationV1 | undefined,
	right: StructuredAgentRuntimeProjectionGenerationV1 | undefined,
): boolean {
	return (
		!!left &&
		!!right &&
		sameDureBackendRouteAuthority(left.routeAuthority, right.routeAuthority) &&
		left.bindingRevision === right.bindingRevision &&
		left.runtimeGeneration === right.runtimeGeneration &&
		left.providerEpoch === right.providerEpoch
	);
}

type InspectStructuredAgentRuntime = (
	agentId: string,
) => Promise<DureAgentRuntimeProjectionInspectResultV1>;

const structuredProjectionInspections = new Map<
	string,
	Promise<DureAgentRuntimeProjectionInspectResultV1>
>();
async function inspectCurrentStructuredRuntimeProjection(
	source: StructuredAgentRuntimeProjectionSourceV1,
	inspect?: InspectStructuredAgentRuntime,
) {
	return inspectAgentRuntimeProjection(source, inspect);
}

/** Shares authority-fenced selected snapshots across equal Chat recovery
 * requests. The interaction session keeps a replacement from inheriting the
 * retired pane's in-flight observation. */
export function inspectStructuredAgentRuntimeProjection(
	source: StructuredAgentRuntimeProjectionSourceV1,
	inspect?: InspectStructuredAgentRuntime,
	expectedGeneration?: StructuredAgentRuntimeProjectionGenerationV1,
): Promise<DureAgentRuntimeProjectionInspectResultV1> {
	if (inspect)
		return inspectCurrentStructuredRuntimeProjection(source, inspect);
	const key = JSON.stringify([
		source.agentId,
		source.backendProfileId,
		source.interactionSessionId,
		expectedGeneration?.routeAuthority ?? null,
		expectedGeneration?.bindingRevision ?? null,
		expectedGeneration?.runtimeGeneration ?? null,
		expectedGeneration?.providerEpoch ?? null,
	]);
	const existing = structuredProjectionInspections.get(key);
	if (existing) return existing;
	const observation = inspectCurrentStructuredRuntimeProjection(source);
	structuredProjectionInspections.set(key, observation);
	const clear = () => {
		if (structuredProjectionInspections.get(key) === observation) {
			structuredProjectionInspections.delete(key);
		}
	};
	void observation.then(clear, clear);
	return observation;
}

/** Resolve the workspace identity needed by a sibling native launch without
 * persisting backend-owned workspace facts on a structured Agent. */
export async function inspectStructuredAgentRuntimeProjectionContext(
	source: StructuredAgentRuntimeProjectionSourceV1,
	dependencies?: {
		readonly inspect?: InspectStructuredAgentRuntime;
	},
): Promise<
	Extract<DureAgentRuntimeProjectionInspectResultV1, { state: "stable" }>
> {
	const observation = await inspectStructuredAgentRuntimeProjection(
		source,
		dependencies?.inspect,
	);
	if (
		observation.state !== "stable" ||
		observation.agentId !== source.agentId ||
		observation.backendProfileId !== source.backendProfileId ||
		observation.interactionProfile !== "structured_protocol" ||
		observation.interactionSessionId !== source.interactionSessionId
	) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	return observation;
}

/** Observes a route-less Agent through one selected exact backend lease. The
 * optional expected authority pins convergence after a Transitioning result;
 * selected reads before and after every observation prevent a replaced profile
 * from becoming pane authority. */
export async function inspectSelectedAgentRuntimeProjection(
	agentId: string,
	options: AgentRuntimeProjectionRecoveryOptions = {},
): Promise<DureAgentRuntimeProjectionInspectResultV1> {
	const dependencies = options.dependencies ?? defaultDependencies;
	const selectedBeforeInspect =
		await dependencies.resolveSelectedRoute(undefined);
	const routeAuthority =
		options.expectedRouteAuthority ?? selectedBeforeInspect;
	if (!sameDureBackendRouteAuthority(routeAuthority, selectedBeforeInspect)) {
		throw backendChanged();
	}
	const observation = await dependencies
		.createClient(routeAuthority.profileId)
		.inspectExact(agentId, routeAuthority);

	const selectedAfterInspect =
		await dependencies.resolveSelectedRoute(undefined);
	if (!sameDureBackendRouteAuthority(routeAuthority, selectedAfterInspect)) {
		throw backendChanged();
	}
	return observation;
}

function backendChanged() {
	return new DureBackendRequestError(
		"agent_runtime_projection_backend_changed",
		t("ipc.dureBackend.generationChanged"),
		{ kind: "authority_changed" },
	);
}

/** Rolling compatibility is safe only when the selected backend explicitly
 * lacks this newly versioned read capability. Other transport, authority, and
 * contract failures remain blocking because they do not prove a legacy
 * backend. */
export function isAgentRuntimeProjectionCapabilityMissing(
	error: unknown,
): boolean {
	return (
		error instanceof DureBackendRequestError &&
		error.code === "backend_transport_capability_missing" &&
		error.failure.kind === "transport" &&
		error.details?.capability === "agent_runtime.projection.inspect"
	);
}
