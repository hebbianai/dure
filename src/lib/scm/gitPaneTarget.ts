import type { SerializedPanelRef } from "@/lib/workspace/layout/layoutLifecycle";

/** A Git view follows its explicit project reference, never its historical ID. */
export function gitProjectIdFromPane(
	pane: Pick<SerializedPanelRef, "component" | "params">,
): string | undefined {
	const projectId = pane.params.projectId;
	return pane.component === "git" &&
		typeof projectId === "string" &&
		projectId.length > 0
		? projectId
		: undefined;
}
