import { describe, expect, it } from "vitest";
import { evaluateAgentProviderMutation } from "@/lib/agents/agentProviderMutationPolicy";
import {
	hmuxManagedBinding,
	hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";

describe("agent provider mutation policy", () => {
	it("fails closed for standalone Hmux conversation and credential mutations", () => {
		const binding = hmuxStandaloneBinding("session", "workspace");
		expect(evaluateAgentProviderMutation(binding, "conversation")).toEqual({
			allowed: false,
			reason: "standalone_rehost_required",
		});
		expect(evaluateAgentProviderMutation(binding, "credential")).toEqual({
			allowed: false,
			reason: "standalone_rehost_required",
		});
	});

	it("leaves managed and legacy runtimes on their existing replacement paths", () => {
		expect(
			evaluateAgentProviderMutation(
				hmuxManagedBinding("session", "workspace"),
				"credential",
			),
		).toEqual({ allowed: true });
		expect(evaluateAgentProviderMutation(undefined, "conversation")).toEqual({
			allowed: true,
		});
	});
});
