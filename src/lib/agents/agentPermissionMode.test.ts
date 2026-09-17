import { describe, expect, it } from "vitest";
import {
	effectiveAgentPermissionMode,
	effectiveAgentSkipPermissions,
} from "@/lib/agents/agentPermissionMode";

describe("effective Agent permission mode", () => {
	it("lets an explicit safe Agent override a global bypass", () => {
		expect(
			effectiveAgentSkipPermissions(
				{ provider: "codex", skipPermissions: false },
				{ codex: true },
			),
		).toBe(false);
		expect(
			effectiveAgentPermissionMode(
				{ provider: "codex", skipPermissions: false },
				{ codex: true },
			),
		).toBe("default");
	});

	it("uses the Agent override before the global default", () => {
		expect(
			effectiveAgentPermissionMode(
				{ provider: "codex", skipPermissions: true },
				{ codex: false },
			),
		).toBe("bypass_approvals");
	});
});
