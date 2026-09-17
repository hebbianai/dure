import type { TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";

export type AgentProviderMutation = "conversation" | "credential";

export interface AgentProviderMutationDecision {
	allowed: boolean;
	reason?: "standalone_rehost_required";
}

/** Provider identity changes must be owned by a runtime that can replace the
 * exact provider process. A standalone Host deliberately exposes terminal
 * control only, so changing Agent metadata would make the UI lie about the
 * conversation or credential that is actually running. */
export function evaluateAgentProviderMutation(
	binding: TerminalPaneBindingV1 | undefined,
	_mutation: AgentProviderMutation,
): AgentProviderMutationDecision {
	return binding?.runtime === "hmux_standalone_v1"
		? { allowed: false, reason: "standalone_rehost_required" }
		: { allowed: true };
}
