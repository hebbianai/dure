import type { ReconciledManagedAgentDurableSuccessor } from "@/lib/sessions/managed/managedAgentDurableSuccessor";
import type { ManagedAgentRecoveryResult } from "@/lib/sessions/managed/managedAgentRuntime";

/** A durable successor plus the optional legacy recovery receipt that found it. */
export interface ReconciledManagedAgentRehost
	extends ReconciledManagedAgentDurableSuccessor {
	recovery?: ManagedAgentRecoveryResult;
}
