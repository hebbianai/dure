import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";

/** What a session surface shows for a Host-observed session. */
export type SessionRuntimeDisplayState = Extract<
	AgentDisplayState,
	"exited" | "blocked" | "working" | "waiting"
>;

/** The one derivation from a Host semantic snapshot to a session surface
 * state. Pane chrome, terminal panes, Spaces rows and native search all read
 * it; none of them keeps a second copy of the snapshot's activity.
 *
 * Order matters: a process the Host reports gone is exited whatever attention
 * it last raised — stale approval on a dead session is not something a person
 * can answer. Attention then outranks activity because it is the state that
 * asks for a person. A `starting` session shows its activity, as it always
 * did on these surfaces. */
export function sessionRuntimeDisplayState(
	runtime:
		| Pick<HmuxAgentRuntimeState, "lifecycle" | "activity" | "attention">
		| undefined,
): SessionRuntimeDisplayState | undefined {
	if (!runtime) return undefined;
	if (runtime.lifecycle === "exited") return "exited";
	if (runtime.attention !== "none") return "blocked";
	return runtime.activity;
}
