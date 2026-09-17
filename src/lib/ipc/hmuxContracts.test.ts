import { describe, expect, it } from "vitest";
import type { HmuxManagedRehostResolution } from "./hmuxContracts";

const resolved = {
	schema: "hmux-managed-rehost-resolution-v1",
	schemaVersion: 1,
	state: "resolved",
	operationIds: ["operation-1"],
	sourceGeneration: {
		sessionId: "source",
		workspaceId: "workspace",
		runnerPrincipal: "principal-source",
		runnerInstance: "runner-source",
		channelEpoch: "1",
		hostInstanceId: "host-source",
		terminalEpoch: "terminal-source",
	},
	currentGeneration: {
		sessionId: "replacement",
		workspaceId: "workspace",
		runnerPrincipal: "principal-replacement",
		runnerInstance: "runner-replacement",
		channelEpoch: "2",
		hostInstanceId: "host-replacement",
		terminalEpoch: "terminal-replacement",
	},
	providerId: "codex",
	permissionMode: "default",
} satisfies Extract<HmuxManagedRehostResolution, { state: "resolved" }>;

describe("Hmux managed rehost resolution contract", () => {
	it("distinguishes an unavailable identity from known default/fresh selections", () => {
		const unavailable = resolved;
		const knownFresh = { ...resolved, launchIdentity: {} } satisfies Extract<
			HmuxManagedRehostResolution,
			{ state: "resolved" }
		>;
		const knownExact = {
			...resolved,
			launchIdentity: {
				launchReference: "credential+profile",
				conversationId: "conversation-final",
			},
		} satisfies Extract<HmuxManagedRehostResolution, { state: "resolved" }>;

		expect("launchIdentity" in unavailable).toBe(false);
		expect(knownFresh.launchIdentity).toEqual({});
		expect(knownExact.launchIdentity).toEqual({
			launchReference: "credential+profile",
			conversationId: "conversation-final",
		});
	});
});
