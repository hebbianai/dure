import { describe, expect, it } from "vitest";
import {
	HMUX_LOCAL_SHELL_WORKSPACE_ID,
	isHmuxProviderSessionSourceBinding,
	isHmuxProviderSessionSourceIdentity,
} from "@/lib/hmux/identity/hmuxProviderSessionSource";
import {
	hmuxManagedBinding,
	hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";

describe("Hmux provider session source identity", () => {
	it("accepts local standalone and canonical managed shell sources", () => {
		expect(
			isHmuxProviderSessionSourceBinding(
				hmuxStandaloneBinding("standalone", "workspace"),
				"agent",
			),
		).toBe(true);
		expect(
			isHmuxProviderSessionSourceBinding(
				hmuxManagedBinding("managed-shell", HMUX_LOCAL_SHELL_WORKSPACE_ID),
				"terminal",
			),
		).toBe(true);
	});

	it("does not reinterpret an ordinary managed Agent as a shell source", () => {
		expect(
			isHmuxProviderSessionSourceBinding(
				hmuxManagedBinding("managed-agent", "project-workspace"),
				"terminal",
			),
		).toBe(false);
		expect(
			isHmuxProviderSessionSourceBinding(
				hmuxManagedBinding("promoted-agent", HMUX_LOCAL_SHELL_WORKSPACE_ID),
				"agent",
			),
		).toBe(false);
		expect(
			isHmuxProviderSessionSourceIdentity({
				kind: "term",
				runtime: "hmux_managed_v1",
				source: "ssh",
				workspaceId: HMUX_LOCAL_SHELL_WORKSPACE_ID,
			}),
		).toBe(false);
	});
});
