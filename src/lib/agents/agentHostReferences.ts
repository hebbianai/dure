import type { Agent } from "@/types";

/** Typed SSH Host registrations required by one Agent runtime. */
export function agentHostReferenceIds(agent: Agent): ReadonlySet<string> {
	const binding = agent.runtimeBinding;
	return new Set(
		binding?.source === "ssh" && binding.hostId.length > 0
			? [binding.hostId]
			: [],
	);
}

export function agentReferencesHost(agent: Agent, hostId: string): boolean {
	return agentHostReferenceIds(agent).has(hostId);
}
