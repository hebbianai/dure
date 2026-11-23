import { describe, expect, it } from "vitest";
import {
	hmuxLocalBinding,
	hmuxManagedBinding,
	hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import {
	agentSessionWindowTarget,
	agentSessionWindowTargetKey,
} from "@/lib/workspace/window/agentSessionWindowTarget";
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

const chatProfile = {
	schemaVersion: 1,
	kind: "structured_protocol",
	backendProfileId: "local",
	interactionSessionId: "interaction-1",
} as const;

function agent(runtimeBinding: Agent["runtimeBinding"]): Agent {
	return agentFixture({ runtimeBinding });
}

function chatAgent(patch: Partial<Agent> = {}): Agent {
	return agentFixture({
		provider: "claude",
		interactionProfile: chatProfile,
		runtimeBinding: undefined,
		...patch,
	});
}

describe("agentSessionWindowTarget", () => {
	it("presents a Terminal Agent's input-capable managed Hmux identity", () => {
		const binding = hmuxManagedBinding("session-1", "workspace-1");
		expect(agentSessionWindowTarget(agent(binding))).toEqual({
			kind: "terminal",
			binding,
		});
	});

	it("accepts standalone Hmux but rejects the old observer-only binding", () => {
		expect(
			agentSessionWindowTarget(
				agent(hmuxStandaloneBinding("session-1", "workspace-1")),
			)?.kind,
		).toBe("terminal");
		expect(
			agentSessionWindowTarget(
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
			agentSessionWindowTarget(agent(legacyLocalBinding("session-1"))),
		).toBeUndefined();
		expect(
			agentSessionWindowTarget(
				agent(hmuxManagedBinding("other-session", "workspace-1")),
			),
		).toBeUndefined();
		expect(
			agentSessionWindowTarget({
				...agent(hmuxManagedBinding("session-1", "workspace-1")),
				sessionKind: "ssh",
			}),
		).toBeUndefined();
	});

	it("presents a Chat Agent from its interaction session, without a pane binding", () => {
		expect(agentSessionWindowTarget(chatAgent())).toEqual({
			kind: "chat",
			profile: chatProfile,
		});
		// The Chat identity is the backend session, not the local session kind.
		expect(
			agentSessionWindowTarget(chatAgent({ sessionKind: "ssh" })),
		).toEqual({ kind: "chat", profile: chatProfile });
	});

	it("refuses a Chat profile that still carries a terminal binding", () => {
		expect(
			agentSessionWindowTarget(
				chatAgent({
					runtimeBinding: hmuxManagedBinding("session-1", "workspace-1"),
				}),
			),
		).toBeUndefined();
	});

	it("refuses a malformed Chat profile instead of falling back to a terminal", () => {
		expect(
			agentSessionWindowTarget(
				chatAgent({
					interactionProfile: {
						...chatProfile,
						interactionSessionId: "",
					},
				}),
			),
		).toBeUndefined();
	});

	it("follows the Agent when its View moves between Terminal and Chat", () => {
		const binding = hmuxManagedBinding("session-1", "workspace-1");
		const terminal = agentSessionWindowTarget(agent(binding));
		const chat = agentSessionWindowTarget(chatAgent());
		expect(terminal?.kind).toBe("terminal");
		expect(chat?.kind).toBe("chat");
		expect(agentSessionWindowTargetKey(terminal)).not.toBe(
			agentSessionWindowTargetKey(chat),
		);
	});
});

describe("agentSessionWindowTargetKey", () => {
	it("names one presentation generation per runtime identity", () => {
		expect(agentSessionWindowTargetKey(undefined)).toBeUndefined();
		const first = agentSessionWindowTargetKey(
			agentSessionWindowTarget(chatAgent()),
		);
		const sameSession = agentSessionWindowTargetKey(
			agentSessionWindowTarget(chatAgent({ name: "renamed" })),
		);
		const nextSession = agentSessionWindowTargetKey(
			agentSessionWindowTarget(
				chatAgent({
					interactionProfile: {
						...chatProfile,
						interactionSessionId: "interaction-2",
					},
				}),
			),
		);
		expect(first).toBe(sameSession);
		expect(first).not.toBe(nextSession);
	});
});
