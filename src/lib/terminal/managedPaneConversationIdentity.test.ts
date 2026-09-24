import { describe, expect, it } from "vitest";
import type { HmuxProviderConversationIdentity } from "@/lib/ipc";
import {
	type HmuxManagedPaneBindingV1,
	hmuxManagedBinding,
	type RemoteHmuxManagedPaneBindingV1,
	remoteHmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import { projectManagedPaneConversationIdentity } from "./managedPaneConversationIdentity";

const stopFence = {
	runnerPrincipal: "runner-user",
	runnerInstance: "runner-instance",
	channelEpoch: "7",
	hostInstanceId: "host-instance",
	terminalEpoch: "terminal-epoch",
} as const;

function remoteBinding(): RemoteHmuxManagedPaneBindingV1 {
	return remoteHmuxManagedBinding(
		"remote-session",
		"remote-workspace",
		"remote-host",
		"bridge-nonce",
		"create-key",
		stopFence,
		"account-codex",
		".dure/accounts/account-codex",
	);
}

function localBinding(): HmuxManagedPaneBindingV1 {
	return hmuxManagedBinding(
		"remote-session",
		"remote-workspace",
		"account-codex",
		4,
		stopFence,
	);
}

function identity(): HmuxProviderConversationIdentity {
	return {
		sessionId: "remote-session",
		workspaceId: "remote-workspace",
		...stopFence,
		revision: "3",
		observedThroughOutputSeq: "42",
		providerId: "codex",
		conversationId: "conversation-123",
		source: "provider_event",
	};
}

describe("managed pane conversation identity projection", () => {
	it("hydrates a local binding from its exact attached Host generation", () => {
		const current = localBinding();

		expect(
			projectManagedPaneConversationIdentity(current, current, identity()),
		).toEqual({
			...current,
			conversationIdentity: { schemaVersion: 1, ...identity() },
		});
	});

	it.each([
		["create operation", { createIdempotencyKey: "other-create" }],
		["credential", { credentialId: "other-account" }],
		["credential generation", { credentialGeneration: 5 }],
		[
			"stop fence",
			{ stopFence: { ...stopFence, terminalEpoch: "other-terminal" } },
		],
	] as const)("rejects a stale local %s attachment", (_name, changed) => {
		const current = localBinding();
		const attached = {
			...current,
			...changed,
		} as HmuxManagedPaneBindingV1;

		expect(
			projectManagedPaneConversationIdentity(current, attached, identity()),
		).toBe(current);
	});

	it("hydrates a missing identity on the exact attached generation", () => {
		const current = remoteBinding();

		expect(
			projectManagedPaneConversationIdentity(current, current, identity()),
		).toEqual({
			...current,
			conversationIdentity: { schemaVersion: 1, ...identity() },
		});
	});

	it("does not rewrite an already current Host projection", () => {
		const current = projectManagedPaneConversationIdentity(
			remoteBinding(),
			remoteBinding(),
			identity(),
		);

		expect(
			projectManagedPaneConversationIdentity(
				current,
				remoteBinding(),
				identity(),
			),
		).toBe(current);
	});

	it("keeps a continued conversation when an older projection arrives later", () => {
		const attached = localBinding();
		const original = projectManagedPaneConversationIdentity(
			attached,
			attached,
			identity(),
		);
		const continued = projectManagedPaneConversationIdentity(
			original,
			attached,
			{
				...identity(),
				revision: "4",
				conversationId: "continued-conversation",
			},
		);
		expect(
			projectManagedPaneConversationIdentity(continued, attached, identity()),
		).toBe(continued);
		expect(
			projectManagedPaneConversationIdentity(continued, attached, {
				...identity(),
				revision: "4",
			}),
		).toBe(continued);
	});

	it("persists a later typed projection without synthesizing its revision", () => {
		const attached = remoteBinding();
		const current = projectManagedPaneConversationIdentity(
			attached,
			attached,
			identity(),
		);
		const later = {
			...identity(),
			revision: "9",
			observedThroughOutputSeq: "81",
			source: "provider_event",
		} as const;

		const projected = projectManagedPaneConversationIdentity(
			current,
			attached,
			later,
		);
		expect(
			projected?.runtime === "hmux_managed_v1" && projected.source === "ssh"
				? projected.conversationIdentity
				: undefined,
		).toEqual({ schemaVersion: 1, ...later });
	});

	it.each([
		["host", { hostId: "other-host" }],
		["session", { sessionId: "other-session" }],
		["workspace", { workspaceId: "other-workspace" }],
		["create operation", { createIdempotencyKey: "other-create" }],
		["bridge", { commandBridgeNonce: "other-bridge" }],
		["credential", { credentialId: "other-account" }],
		[
			"credential directory",
			{ credentialProfileDirectory: ".dure/accounts/other-account" },
		],
		[
			"stop fence",
			{ stopFence: { ...stopFence, terminalEpoch: "other-terminal" } },
		],
	] as const)("rejects a stale %s attachment", (_name, changed) => {
		const current = remoteBinding();
		const attached = {
			...current,
			...changed,
		} as RemoteHmuxManagedPaneBindingV1;

		expect(
			projectManagedPaneConversationIdentity(current, attached, identity()),
		).toBe(current);
	});

	it.each([
		["session", { sessionId: "other-session" }],
		["workspace", { workspaceId: "other-workspace" }],
		["runner principal", { runnerPrincipal: "other-principal" }],
		["runner instance", { runnerInstance: "other-runner" }],
		["channel epoch", { channelEpoch: "8" }],
		["Host instance", { hostInstanceId: "other-host-instance" }],
		["terminal epoch", { terminalEpoch: "other-terminal" }],
	] as const)(
		"rejects a Host projection outside the exact %s",
		(_name, changed) => {
			const current = remoteBinding();

			expect(
				projectManagedPaneConversationIdentity(current, current, {
					...identity(),
					...changed,
				}),
			).toBe(current);
		},
	);
});
