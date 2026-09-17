import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type { AccountProfile, Agent } from "@/types";

export interface ManagedAgentRecoveryExecutionOptions {
	columns: number;
	rows: number;
	confirmed: boolean;
	requireSocketOwnerAbsent?: true;
	credentialAccount?: AccountProfile;
	/** The caller already completed provider/credential preflight and
	 * re-fenced its UI state immediately before this backend transaction. */
	preflighted?: boolean;
	/** Runs only when no durable completion exists. It performs the final UI
	 * race fence for first admission and returns that exact launch snapshot. */
	prepareFirstAdmission?: (
		backendRouteAuthority: DureBackendRouteAuthorityV1,
	) => Agent | Promise<Agent>;
	/** Exact installed build confirmed by a guided rehost preview. The backend
	 * journals and resolves this immutable build before source retirement. */
	expectedTargetBuildId?: string;
}
