import { type QuickCommand, QuickCommandInputError } from "./quickCommands";

export type PaneQuickCommandTarget = (command: QuickCommand) => Promise<void>;
const targets = new Map<string, PaneQuickCommandTarget>();

/** Window-local routing shared by pane header and content menus. The mounted
 * input surface retains all attachment/epoch and input-capability authority. */
export function registerPaneQuickCommandTarget(
	surfaceId: string,
	target: PaneQuickCommandTarget,
) {
	if (targets.has(surfaceId))
		throw new Error(`Duplicate pane input surface: ${surfaceId}`);
	targets.set(surfaceId, target);
	return () => {
		if (targets.get(surfaceId) === target) targets.delete(surfaceId);
	};
}

/** A menu captures its destination when opened; never re-resolve after selection. */
export function capturePaneQuickCommandTarget(
	surfaceId: string,
): PaneQuickCommandTarget | undefined {
	const target = targets.get(surfaceId);
	if (!target) return undefined;
	return (command) => {
		if (targets.get(surfaceId) !== target)
			return Promise.reject(
				new QuickCommandInputError("workspace.quickCommands.unavailable"),
			);
		return target(command);
	};
}
