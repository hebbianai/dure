import type { Agent, Provider } from "@/types";

export function effectiveAgentSkipPermissions(
	agent: Pick<Agent, "provider" | "skipPermissions">,
	globalByProvider: Readonly<Partial<Record<Provider, boolean>>>,
): boolean {
	return agent.skipPermissions ?? Boolean(globalByProvider[agent.provider]);
}

export function effectiveAgentPermissionMode(
	agent: Pick<Agent, "provider" | "skipPermissions">,
	globalByProvider: Readonly<Partial<Record<Provider, boolean>>>,
): "default" | "bypass_approvals" {
	return effectiveAgentSkipPermissions(agent, globalByProvider)
		? "bypass_approvals"
		: "default";
}
