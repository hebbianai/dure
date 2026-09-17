import type { AgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import { sameAgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import type {
	DureAgentRuntimeInspectResultV1,
	DureAgentRuntimeLaunchSelectionTargetV1,
} from "@/lib/ipc/dureAgentRuntime";

interface RuntimeConvergenceTarget {
	interactionProfile: "native_cli" | "structured_protocol";
	executionProfile?: AgentExecutionProfileV1;
	launchSelection?: DureAgentRuntimeLaunchSelectionTargetV1;
}

interface RuntimeConvergenceOptions {
	target?: RuntimeConvergenceTarget;
	/** Explicit reads must not wait forever on a backend transition. */
	maxInspections?: number;
	shouldContinue?: () => boolean;
	wait?: (milliseconds: number) => Promise<void>;
	onTransitioning?: (
		observation: Extract<
			DureAgentRuntimeInspectResultV1,
			{ state: "transitioning" }
		>,
	) => void;
}

function matchesTarget(
	observation: Extract<DureAgentRuntimeInspectResultV1, { state: "stable" }>,
	target: RuntimeConvergenceTarget,
) {
	const requestedLaunch = target.launchSelection;
	return (
		observation.interactionProfile === target.interactionProfile &&
		(!target.executionProfile ||
			sameAgentExecutionProfileV1(
				observation.executionProfile,
				target.executionProfile,
			)) &&
		(!requestedLaunch ||
			(observation.launchSelection.model === requestedLaunch.model &&
				observation.launchSelection.effort === requestedLaunch.effort &&
				(requestedLaunch.permissionMode === undefined ||
					observation.launchSelection.permissionMode ===
						requestedLaunch.permissionMode)))
	);
}

const defaultWait = (milliseconds: number) =>
	new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));

/** Read-only convergence for initial attach, ordinary transitions, and an
 * already-consumed repair authorization. The durable backend remains the only
 * state machine; this helper merely waits for its next authoritative snapshot. */
export async function observeRuntimeConvergence<
	Observation extends DureAgentRuntimeInspectResultV1,
>(
	client: {
		inspect(agentId: string): Promise<Observation>;
	},
	agentId: string,
	options: RuntimeConvergenceOptions = {},
): Promise<Exclude<Observation, { state: "transitioning" }> | undefined> {
	let retryDelayMs = 50;
	let inspections = 0;
	const maxInspections = options.maxInspections ?? Number.POSITIVE_INFINITY;
	const shouldContinue = options.shouldContinue ?? (() => true);
	const wait = options.wait ?? defaultWait;
	while (shouldContinue() && inspections < maxInspections) {
		const observation = await client.inspect(agentId);
		inspections += 1;
		if (!shouldContinue()) return undefined;
		if (observation.state === "transitioning") {
			options.onTransitioning?.(observation);
			if (inspections >= maxInspections) return undefined;
			await wait(retryDelayMs);
			retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
			continue;
		}
		return observation as Exclude<Observation, { state: "transitioning" }>;
	}
	return undefined;
}

export function runtimeObservationMatchesTarget(
	observation: DureAgentRuntimeInspectResultV1,
	target: RuntimeConvergenceTarget,
): observation is Extract<
	DureAgentRuntimeInspectResultV1,
	{ state: "stable" }
> {
	return observation.state === "stable" && matchesTarget(observation, target);
}
