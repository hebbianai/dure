import { describe, expect, it } from "vitest";
import {
	hmuxLocalBinding,
	hmuxManagedBinding,
	hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import { agentSessionWindowBinding } from "@/lib/workspace/window/agentSessionWindowTarget";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const legacyLocalBinding = (sessionId: string) =>
	({
		schemaVersion: 1,
		runtime: "legacy_session_v1",
		source: "local",
		hostId: "local",
		sessionId,
	}) as unknown as import("@/types").Agent["runtimeBinding"];

function agent(runtimeBinding: Agent["runtimeBinding"]): Agent {
	return agentFixture({ runtimeBinding });
}

describe("agentSessionWindowBinding", () => {
	it("accepts an input-capable managed Hmux identity", () => {
		const binding = hmuxManagedBinding("session-1", "workspace-1");
		expect(agentSessionWindowBinding(agent(binding))).toEqual(binding);
	});

	it("accepts standalone Hmux but rejects the old observer-only binding", () => {
		expect(
			agentSessionWindowBinding(
				agent(hmuxStandaloneBinding("session-1", "workspace-1")),
			),
		).toBeTruthy();
		expect(
			agentSessionWindowBinding(
				agent(
					hmuxLocalBinding(
						"session-1",
						"workspace-1",
					) as unknown as Agent["runtimeBinding"],
				),
			),
		).toBeUndefined();
	});

	it("rejects legacy, mismatched session, and mismatched source records", () => {
		expect(
			agentSessionWindowBinding(agent(legacyLocalBinding("session-1"))),
		).toBeUndefined();
		expect(
			agentSessionWindowBinding(
				agent(hmuxManagedBinding("other-session", "workspace-1")),
			),
		).toBeUndefined();
		expect(
			agentSessionWindowBinding({
				...agent(hmuxManagedBinding("session-1", "workspace-1")),
				sessionKind: "ssh",
			}),
		).toBeUndefined();
	});
});
