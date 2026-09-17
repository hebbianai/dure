import { useCallback } from "react";
import { useAgentChatSession } from "@/components/agents/chat/useAgentChatSession";
import { useUsageLimitHandoff } from "@/components/agents/chat/useUsageLimitHandoff";
import { requestAgentCredentialTransition } from "@/lib/agents/agentCredentialTransition";
import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import { recoverStructuredAgentRuntimeProjection } from "@/lib/agents/agentRuntimeTransitionAction";
import type { StructuredAgentRuntimeProjectionGenerationV1 } from "@/lib/agents/agentRuntimeProjectionRecovery";
import type { AgentStructuredInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { resumeUsageLimitTurn } from "@/lib/agents/chat/resumeUsageLimitTurn";
import { latestTurnFailure } from "@/lib/agents/chat/turnFailureReason";
import { useManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import { useStore } from "@/store";
import type { Agent } from "@/types";

/** The main client keeps local Chat recovery alive independently of its views.
 * Panes and this host lease the existing conversation controller and share the
 * same once-per-failure handoff policy. No hidden panes or second task registry. */
export function AgentUsageLimitHandoffHost() {
	const agents = useStore((state) => state.agents);
	const automatic = useStore((state) => state.autoSwitchAccounts);
	if (!automatic) return null;
	return agents.map((agent) => {
		const profile = agent.interactionProfile;
		return profile?.kind === "structured_protocol" &&
			profile.backendProfileId === "local" ? (
			<AgentUsageLimitObserver key={agent.id} agent={agent} profile={profile} />
		) : null;
	});
}

function AgentUsageLimitObserver({
	agent,
	profile,
}: {
	agent: Agent;
	profile: AgentStructuredInteractionProfileV1;
}) {
	const accounts = useStore((state) => state.accounts);
	const switching = useManagedCredentialSwitchTransition(
		agent.id,
		agent.pendingCredentialSwitch,
	);
	const onRuntimeInvalidated = useCallback(
		async (generation: StructuredAgentRuntimeProjectionGenerationV1) =>
			Boolean(
				await recoverStructuredAgentRuntimeProjection(
					{
						agentId: agent.id,
						backendProfileId: profile.backendProfileId,
						interactionSessionId: profile.interactionSessionId,
					},
					{ kind: "observed_generation", generation },
				),
			),
		[agent.id, profile.backendProfileId, profile.interactionSessionId],
	);
	const session = useAgentChatSession(agent.id, profile, onRuntimeInvalidated);
	const page = "page" in session ? session.page : undefined;
	useUsageLimitHandoff({
		agentId: agent.id,
		provider: agent.provider,
		automatic: true,
		accountMovesLocked:
			switching ||
			session.sending ||
			Boolean("activeTurn" in session && session.activeTurn),
		currentCredentialId: agentCredentialReferenceId(agent),
		pool: accounts.filter((account) => account.provider === agent.provider),
		failure: page ? latestTurnFailure(page.rows) : undefined,
		performAccountSwitch: (targetCredentialId) =>
			requestAgentCredentialTransition({
				agentId: agent.id,
				targetCredentialId,
				sourcePanelId: `agent:${agent.id}`,
			}),
		resumeAfterHandoff: resumeUsageLimitTurn,
	});
	return null;
}
