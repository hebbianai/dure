import type { DureAgentRuntimeLaunchSelectionV1 } from "@/lib/ipc/dureAgentRuntime";
import {
	type DureBackendRouteAuthorityV1,
	sameDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackendRoute";

export interface AgentRuntimeLaunchPresentation {
	readonly ownerKey: string;
	readonly routeAuthority: DureBackendRouteAuthorityV1;
	readonly selectionRevision: number;
	readonly launchSelection: DureAgentRuntimeLaunchSelectionV1;
}

/** A backend selection revision is the sole ordering authority. The complete
 * newest snapshot replaces the older pane projection directly. */
export function projectAgentRuntimeLaunchPresentation(
	current: AgentRuntimeLaunchPresentation | undefined,
	incoming: AgentRuntimeLaunchPresentation,
): AgentRuntimeLaunchPresentation {
	if (
		!current ||
		!sameDureBackendRouteAuthority(
			current.routeAuthority,
			incoming.routeAuthority,
		)
	) {
		return incoming;
	}
	if (current.selectionRevision > incoming.selectionRevision) return current;
	return current.selectionRevision === incoming.selectionRevision &&
		current.ownerKey === incoming.ownerKey &&
		sameLaunchSelection(current, incoming)
		? current
		: incoming;
}

function sameLaunchSelection(
	left: AgentRuntimeLaunchPresentation,
	right: AgentRuntimeLaunchPresentation,
) {
	return (
		left.launchSelection.model === right.launchSelection.model &&
		left.launchSelection.effort === right.launchSelection.effort &&
		left.launchSelection.permissionMode ===
			right.launchSelection.permissionMode
	);
}
