import { computePromptIdentity } from "@/lib/agents/promptIdentity";
import { sameRemoteManagedBinding } from "@/lib/sessions/managed/remoteManagedBindingEquality";
import type {
	CanonicalAddAgentRunPolicy,
	CanonicalRunPaneTarget,
} from "@/lib/agents/addAgentCanonicalRun";
import { addAgent } from "@/lib/agents/agentRegistration";
import { ensureRemoteManagedAgentRuntime } from "@/lib/sessions/launch/remoteManagedAgentRuntime";
import { sendHmuxInitialAgentPrompt } from "@/lib/sessions/managed/managedAgentInput";
import { ensureProviderLaunchDefaultsProjection } from "@/lib/settings/providerLaunchDefaults";
import { openAgentPanelOnDesktop } from "@/lib/workspace/dock";
import { useStore } from "@/store";
import type { Agent } from "@/types";
import {
	quickDispatchRemoteTarget,
	sameQuickDispatchRemoteTarget,
} from "./quickDispatchDefaults";
import type { QuickDispatchRemoteTarget } from "./quickDispatchIntent";

const running = new Map<string, Promise<Agent>>();

/** Reuse the SSH registration/create/input authorities. The journal's stable ID
 * owns one registration; retrying never mints another Agent or conversation. */
export async function runRemoteQuickDispatch(
	input: CanonicalAddAgentRunPolicy,
	paneTarget: CanonicalRunPaneTarget | null,
	expected: QuickDispatchRemoteTarget,
): Promise<Agent> {
	const pending = running.get(input.actionId);
	if (pending) return pending;
	const execute = async () => {
		const checkTarget = () => {
			const state = useStore.getState();
			const project = state.projects.find(
				(candidate) => candidate.id === input.project.id,
			);
			if (
				project?.kind !== "ssh" ||
				!sameQuickDispatchRemoteTarget(
					quickDispatchRemoteTarget(project, state.sshHosts),
					expected,
				)
			)
				throw new Error("quick_dispatch_target_changed");
		};
		checkTarget();
		await ensureProviderLaunchDefaultsProjection();
		checkTarget();
		const id = `agent-${input.actionId}`;
		let agent = useStore
			.getState()
			.agents.find((candidate) => candidate.id === id);
		if (
			agent &&
			(agent.projectId !== input.project.id ||
				agent.provider !== input.provider ||
				agent.worktreePath !==
					(input.useWorktree
						? input.worktreePlan?.worktreePath
						: input.project.path) ||
				(agent.credentialId ?? null) !== input.accountId)
		)
			throw new Error("quick_dispatch_registration_changed");
		if (!agent) {
			agent = await addAgent({
				id,
				projectId: input.project.id,
				name: input.agentName,
				provider: input.provider,
				accountId: input.accountId,
				useWorktree: input.useWorktree,
				worktreePlan: input.worktreePlan,
				skipPermissions:
					input.permissionOverride === undefined
						? undefined
						: input.permissionOverride === "bypass_approvals",
			});
		}
		checkTarget();
		const receipt = await ensureRemoteManagedAgentRuntime(agent, {
			columns: 120,
			rows: 30,
			initialPrompt: input.prompt,
			launchOptions: {
				model: input.model,
				effort: input.effort,
				permissionOverride: input.permissionOverride,
				setupCommand: input.setupCommand ?? undefined,
			},
		});
		checkTarget();
		// Present the committed session so setup output stays visible while the
		// Host waits for providers that receive their first prompt through input.
		if (paneTarget) openAgentPanelOnDesktop(paneTarget.spaceId, receipt.agent);
		// Providers without argv prompt support use the existing one-shot Host write.
		let launched = receipt.agent;
		if (input.prompt && !receipt.initialPromptAccepted) {
			await sendHmuxInitialAgentPrompt(receipt.agent, input.prompt);
			const { promptDigest } = await computePromptIdentity(input.prompt);
			useStore.setState((state) => ({
				agents: state.agents.map((current) => {
					if (
						current.id === receipt.agent.id &&
						current.runtimeBinding?.source === "ssh" &&
						current.runtimeBinding.runtime === "hmux_managed_v1" &&
						receipt.agent.runtimeBinding?.source === "ssh" &&
						receipt.agent.runtimeBinding.runtime === "hmux_managed_v1" &&
						sameRemoteManagedBinding(
							current.runtimeBinding,
							receipt.agent.runtimeBinding,
						)
					) {
						launched = {
							...current,
							runtimeBinding: {
								...current.runtimeBinding,
								initialPromptDigest: promptDigest,
							},
						};
						return launched;
					}
					return current;
				}),
			}));
		}
		return launched;
	};
	const operation = execute();
	running.set(input.actionId, operation);
	try {
		return await operation;
	} finally {
		if (running.get(input.actionId) === operation)
			running.delete(input.actionId);
	}
}
