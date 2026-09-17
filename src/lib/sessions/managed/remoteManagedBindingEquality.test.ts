import { describe, expect, it } from "vitest";
import { sameRemoteManagedBinding } from "@/lib/sessions/managed/remoteManagedBindingEquality";
import type {
	HmuxManagedPaneBindingV1,
	RemoteHmuxManagedPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { stopFenceFixture } from "@/test/agentFixtures";

function fence(terminalEpoch = "epoch-1") {
	return stopFenceFixture({ hostInstanceId: "host-1", terminalEpoch });
}

function binding(): RemoteHmuxManagedPaneBindingV1 {
	return {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		source: "ssh",
		hostId: "ssh-1",
		sessionId: "session-1",
		workspaceId: "workspace-1",
		createIdempotencyKey: "create-1",
		commandBridgeNonce: "nonce-1",
		backendProfileId: "remote-a",
		credentialId: "credential-1",
		credentialProfileDirectory: ".dure/accounts/credential-1",
		stopFence: fence(),
	};
}

describe("sameRemoteManagedBinding", () => {
	it("accepts the exact same remote managed generation", () => {
		expect(sameRemoteManagedBinding(binding(), binding())).toBe(true);
	});

	it("rejects a missing or non-remote left binding", () => {
		expect(sameRemoteManagedBinding(undefined, binding())).toBe(false);
		const local: HmuxManagedPaneBindingV1 = {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			sessionId: "session-1",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-1",
			credentialId: "credential-1",
			stopFence: fence(),
		};
		expect(sameRemoteManagedBinding(local, binding())).toBe(false);
	});

	it("rejects an advanced stop fence generation", () => {
		const left = { ...binding(), stopFence: fence("epoch-2") };
		expect(sameRemoteManagedBinding(left, binding())).toBe(false);
	});

	it("rejects a changed credential locus", () => {
		const left = {
			...binding(),
			credentialProfileDirectory: ".dure/accounts/other",
		};
		expect(sameRemoteManagedBinding(left, binding())).toBe(false);
	});

	it("rejects a changed control-plane route", () => {
		expect(
			sameRemoteManagedBinding(
				{ ...binding(), backendProfileId: "remote-b" },
				binding(),
			),
		).toBe(false);
	});
});
