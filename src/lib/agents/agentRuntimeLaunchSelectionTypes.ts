import type { ProviderPermissionMode } from "../../../cli/lib/contracts/agent-runtime.mjs";

/** Committed launch selection; null model/effort mean the provider CLI's own
 * default. The permission mode is always explicit. */
export interface DureAgentRuntimeLaunchSelectionV1 {
	readonly model: string | null;
	readonly effort: string | null;
	readonly permissionMode: ProviderPermissionMode;
}
