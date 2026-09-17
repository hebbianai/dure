import type { HmuxPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import {
	projectStandaloneHmuxAttachParams,
	sameStandaloneHmuxIdentity,
	standaloneTerminalBinding,
} from "@/lib/hmux/standalone/standaloneHmuxPaneSetProjection";

/** Apply a Host-owned cwd only to the pane generation that produced it. */
export function projectAttachedStandaloneHmuxWorkingDirectory(
	current: Record<string, unknown>,
	attachedBinding: HmuxPaneBindingV1,
	cwd: string,
): Record<string, unknown> | undefined {
	if (
		attachedBinding.runtime !== "hmux_standalone_v1" ||
		attachedBinding.source !== "local"
	) {
		return undefined;
	}
	const currentBinding = standaloneTerminalBinding(current);
	if (
		currentBinding?.runtime !== "hmux_standalone_v1" ||
		!sameStandaloneHmuxIdentity(currentBinding, attachedBinding) ||
		current.cwd === cwd
	) {
		return undefined;
	}
	return projectStandaloneHmuxAttachParams(current, attachedBinding, cwd);
}
