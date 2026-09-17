// "Start an agent here" from a repository head row: one canonical Run in the
// repository's own checkout, no dialog.
//
// This is not a second creation path. It builds the same
// CanonicalAddAgentRunPolicy the add-agent dialog submits and hands it to the
// same runner — quick-add's only authority is over the *choices* the dialog
// would have asked for (no worktree, no setup command, the provider's active
// account). SSH quick-add uses the same registration and managed-runtime
// authorities as the dialog; the policy still owns its provider/account choices.

import type { CanonicalAddAgentRunPolicy } from "@/lib/agents/addAgentCanonicalRun";
import { initialAgentLaunchAccountId } from "@/lib/agents/agentLaunchCredential";
import type { AccountProfile, Project, Provider } from "@/types";

export interface RepositoryQuickAgentInput {
	project: Project;
	provider: Provider;
	agentName: string;
	/** One user action; retries of that action must reuse this identity. */
	actionId: string;
	/** Credential profiles, filtered by the launch-account rule below. */
	accounts: readonly AccountProfile[];
	/** Globally active account for this provider, if any. */
	activeAccountId?: string;
	/** From agentSpawnInteractionPreference — basic interface mode pins the
	 * PTY surface for quick-added agents too. */
	interactionPreference?: "native_cli";
}

/**
 * The policy for a quick add: the repository's own checkout
 * (`useWorktree: false` → the run's `project_root` workspace) under the
 * provider's active account — exactly the dialog's defaults with its
 * worktree tab turned off.
 */
export function repositoryQuickAgentPolicy(
	input: RepositoryQuickAgentInput,
): CanonicalAddAgentRunPolicy {
	// Same selection rule as the dialog's initial state, so quick-add and the
	// dialog can never launch the same provider under different credentials.
	const accountId = initialAgentLaunchAccountId(
		input.provider,
		input.accounts,
		input.activeAccountId,
	);
	const account = accountId
		? input.accounts.find((candidate) => candidate.id === accountId)
		: undefined;
	return {
		project: input.project,
		agentName: input.agentName,
		actionId: input.actionId,
		provider: input.provider,
		accountId,
		...(account ? { account } : {}),
		useWorktree: false,
		setupCommand: null,
		...(input.interactionPreference
			? { interactionPreference: input.interactionPreference }
			: {}),
	};
}
