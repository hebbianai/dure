export type ManagedAgentRehostDisposition =
	| "already_current"
	| "rehost_required";

interface ManagedAgentRehostDispositionInput {
	sourceLifecycle: "ready" | "exited" | "unavailable";
	plan: {
		sourceBuildId: string;
		targetBuildId?: string;
	};
}

/**
 * Projects the backend recovery inspection into an idempotent user action.
 * Lifecycle can only suppress a needless ready same-build restart. The exact
 * backend plan and execution fence still own replacement admission.
 */
export function managedAgentRehostDisposition(
	inspection: ManagedAgentRehostDispositionInput,
): ManagedAgentRehostDisposition {
	const sourceBuildId = inspection.plan.sourceBuildId.trim();
	const targetBuildId = inspection.plan.targetBuildId?.trim();
	return inspection.sourceLifecycle === "ready" &&
		sourceBuildId.length > 0 &&
		targetBuildId !== undefined &&
		sourceBuildId === targetBuildId
		? "already_current"
		: "rehost_required";
}
