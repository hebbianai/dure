import type { WorktreePathDialect } from "@/lib/scm/worktrees/worktreeLocation";
import type { TerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocation";
import type { SessionKind } from "@/types";

export interface SessionKindExecutionProfile {
	readonly transport: "local" | "ssh";
	readonly worktreePathDialect: WorktreePathDialect;
	hostLabel(remoteTarget?: string): string;
	locationOverride(
		remoteTarget?: string,
	): TerminalExecutionLocation | undefined;
}

const SESSION_KIND_EXECUTION_PROFILES: Record<
	SessionKind,
	SessionKindExecutionProfile
> = {
	pty: {
		transport: "local",
		worktreePathDialect: "native",
		hostLabel: () => "local",
		locationOverride: () => undefined,
	},
	ssh: {
		transport: "ssh",
		worktreePathDialect: "posix",
		hostLabel: (remoteTarget) => remoteTarget ?? "ssh",
		locationOverride: (remoteTarget) => ({
			kind: "ssh",
			target: remoteTarget ?? "ssh",
		}),
	},
};

/** Typed execution capability for a session kind; callers do not branch on runtimes. */
export function sessionKindExecutionProfile(
	sessionKind: SessionKind,
): SessionKindExecutionProfile {
	return SESSION_KIND_EXECUTION_PROFILES[sessionKind];
}
