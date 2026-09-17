import { PROVIDER_IDS } from "@/lib/agents/providers";
import { isHmuxManagedGenerationV1 } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import {
	type DureBackendRouteAuthorityV1,
	parseDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackendRoute";
import {
	isManagedAgentDispatchProjectionHandoff,
	type ManagedAgentDispatchProjectionHandoff,
} from "@/lib/sessions/managed/managedAgentDispatchHandoff";
import {
	type HmuxManagedPaneBindingV1,
	isTerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { Provider } from "@/types";

export const MANAGED_AGENT_REHOSTED_EVENT = "agent:managed-rehosted:v2";

export interface ManagedAgentRehostSyncPayload {
	schemaVersion: 2;
	/** Durable Hmux operation whose complete lineage proves this successor. */
	operationId: string;
	/** Missing is the pre-field exact-resume payload shape. */
	launchKind?: "exact_resume" | "fresh" | "resume_new_host";
	/** Exact source mode inspected before the replacement journal is admitted. */
	sourcePermissionMode?: "default" | "bypass_approvals";
	/** Required for fresh so the adapter derives one canonical launch command. */
	permissionMode?: "default" | "bypass_approvals";
	agentId: string;
	agentName: string;
	projectId: string;
	providerId: Provider;
	sourceBinding: HmuxManagedPaneBindingV1;
	/** Explicit null fences legacy Agents that never persisted an identity. */
	sourceConversationId: string | null;
	/** Exact adapter authority captured before the first Dure effect. Missing
	 * only when synchronization itself performs the first Dure effect. */
	backendRouteAuthority?: DureBackendRouteAuthorityV1;
	dispatchProjection?: ManagedAgentDispatchProjectionHandoff;
	/** Missing exited panes are recreated only after the Agent binding CAS. */
	sourcePaneState?: "present" | "absent";
	cwd: string;
	/** null is allowed only for an explicit fresh launch. */
	conversationId: string | null;
	desktopId: string;
	panelId: string;
	binding: HmuxManagedPaneBindingV1;
	/** undefined keeps the existing selector; null selects the runtime default. */
	targetCredentialId?: string | null;
}

/** Normalize a rehost commit input and its optional exact backend lease.
 * Cross-WebView notifications are invalidation hints, not commit inputs. */
export function parseManagedAgentRehostSyncPayload(
	value: unknown,
): ManagedAgentRehostSyncPayload | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const payload = value as Partial<ManagedAgentRehostSyncPayload>;
	if (
		!isTerminalPaneBindingV1(payload.sourceBinding) ||
		payload.sourceBinding.runtime !== "hmux_managed_v1" ||
		payload.sourceBinding.source !== "local" ||
		!isTerminalPaneBindingV1(payload.binding) ||
		payload.binding.runtime !== "hmux_managed_v1" ||
		payload.binding.source !== "local" ||
		!isHmuxManagedGenerationV1(payload.binding.stopFence)
	) {
		return undefined;
	}
	const sourceBinding = payload.sourceBinding;
	const binding = payload.binding;
	const credentialSelectionMatches =
		payload.targetCredentialId === undefined ||
		(payload.targetCredentialId === null
			? binding.credentialId === undefined &&
				binding.credentialGeneration === undefined
			: binding.credentialId === payload.targetCredentialId &&
				(payload.launchKind === "fresh" ||
					binding.credentialGeneration === undefined));
	const conversationSelectionMatches =
		(typeof payload.conversationId === "string" &&
			(payload.launchKind === undefined ||
				payload.launchKind === "exact_resume" ||
				payload.launchKind === "fresh" ||
				payload.launchKind === "resume_new_host")) ||
		(payload.conversationId === null && payload.launchKind === "fresh");
	const permissionModeMatches =
		payload.permissionMode === undefined
			? payload.launchKind !== "fresh"
			: payload.permissionMode === "default" ||
				payload.permissionMode === "bypass_approvals";
	const sourcePermissionModeMatches =
		payload.sourcePermissionMode === undefined ||
		payload.sourcePermissionMode === "default" ||
		payload.sourcePermissionMode === "bypass_approvals";
	const dispatchProjectionMatches =
		payload.dispatchProjection === undefined ||
		isManagedAgentDispatchProjectionHandoff(payload.dispatchProjection);
	const backendRouteAuthority =
		payload.backendRouteAuthority === undefined
			? undefined
			: parseDureBackendRouteAuthority(payload.backendRouteAuthority);
	const backendRouteAuthorityMatches =
		(payload.launchKind === "fresh" ||
			payload.launchKind === "resume_new_host" ||
			backendRouteAuthority !== undefined) &&
		(payload.backendRouteAuthority === undefined ||
			backendRouteAuthority?.profileId ===
				(binding.backendProfileId ?? "local"));
	if (
		payload.schemaVersion !== 2 ||
		typeof payload.operationId !== "string" ||
		!payload.operationId.trim() ||
		!conversationSelectionMatches ||
		!permissionModeMatches ||
		!sourcePermissionModeMatches ||
		!dispatchProjectionMatches ||
		!backendRouteAuthorityMatches ||
		typeof payload.agentId !== "string" ||
		typeof payload.agentName !== "string" ||
		typeof payload.projectId !== "string" ||
		typeof payload.providerId !== "string" ||
		!PROVIDER_IDS.some((providerId) => providerId === payload.providerId) ||
		(payload.sourceConversationId !== undefined &&
			payload.sourceConversationId !== null &&
			typeof payload.sourceConversationId !== "string") ||
		(payload.sourcePaneState !== undefined &&
			payload.sourcePaneState !== "present" &&
			payload.sourcePaneState !== "absent") ||
		typeof payload.cwd !== "string" ||
		typeof payload.desktopId !== "string" ||
		typeof payload.panelId !== "string" ||
		binding.sessionId === sourceBinding.sessionId ||
		(payload.launchKind !== "resume_new_host" &&
			binding.workspaceId !== sourceBinding.workspaceId) ||
		typeof binding.createIdempotencyKey !== "string" ||
		(payload.launchKind === "fresh" &&
			binding.conversationIdentity !== undefined) ||
		(payload.targetCredentialId !== undefined &&
			payload.targetCredentialId !== null &&
			typeof payload.targetCredentialId !== "string") ||
		!credentialSelectionMatches
	) {
		return undefined;
	}
	return {
		...payload,
		...(backendRouteAuthority ? { backendRouteAuthority } : {}),
	} as ManagedAgentRehostSyncPayload;
}

type ResolveSelectedRoute = typeof resolveSelectedDureBackendRouteAuthority;

/** Return the carried rehost lease, or resolve one only after a fresh or
 * target-first Resume launch reaches its first Dure projection effect. Legacy
 * exact-resume payloads fail closed. */
export async function resolveManagedAgentRehostRouteAuthority(
	payload: ManagedAgentRehostSyncPayload,
	resolveSelectedRoute: ResolveSelectedRoute = resolveSelectedDureBackendRouteAuthority,
): Promise<DureBackendRouteAuthorityV1 | undefined> {
	const profileId = payload.binding.backendProfileId ?? "local";
	const authority =
		payload.backendRouteAuthority ??
		(payload.launchKind === "fresh" || payload.launchKind === "resume_new_host"
			? await resolveSelectedRoute(profileId)
			: undefined);
	return authority?.profileId === profileId ? authority : undefined;
}
