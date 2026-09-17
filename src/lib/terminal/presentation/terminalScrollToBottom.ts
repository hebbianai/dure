import type { ViewportFrame } from "@/contracts/terminalStateProtocol";

/** The Host knows whether content remains below even when output or resize
 * invalidates its optional exact distance. Neither distance nor activity gates
 * the return action; visibility follows the current complete projection. */
export function showTerminalScrollToBottom(
	frame: Pick<ViewportFrame, "followTail" | "hasMoreAfter"> | null,
): boolean {
	return Boolean(frame && !frame.followTail && frame.hasMoreAfter);
}
