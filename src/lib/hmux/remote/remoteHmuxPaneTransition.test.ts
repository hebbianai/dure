import { describe, expect, it } from "vitest";
import {
	hmuxManagedBinding,
	hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import {
	acceptRemoteHmuxAttachReceipt,
	activeRemoteHmuxPaneBinding,
	beginRemoteHmuxPaneTransition,
	cancelPreparingRemoteHmuxTransition,
	completeRemoteHmuxExit,
	isRemoteHmuxPaneTransitionV1,
	isRemoteHmuxStandalonePaneBindingV1,
	markRemoteHmuxTransportDisconnected,
	markRemoteHmuxTransportReattached,
	normalizeRemoteHmuxStandalonePaneBindingV1,
	remoteHmuxStandaloneBinding,
} from "@/lib/hmux/remote/remoteHmuxPaneTransition";

describe("remote Hmux pane transition", () => {
	const source = hmuxStandaloneBinding("local-session", "local-workspace");
	const target = remoteHmuxStandaloneBinding(
		"remote-session",
		"remote-workspace",
		"ssh-host-1",
		"bridge-nonce",
	);

	it("keeps local bindings compatible and persists only remote runtime identity", () => {
		expect(source).toEqual({
			schemaVersion: 1,
			runtime: "hmux_standalone_v1",
			source: "local",
			hostId: "local",
			sessionId: "local-session",
			workspaceId: "local-workspace",
		});
		expect(isRemoteHmuxStandalonePaneBindingV1(target)).toBe(true);
		expect(target).toEqual({
			schemaVersion: 1,
			runtime: "hmux_standalone_v1",
			source: "ssh",
			hostId: "ssh-host-1",
			sessionId: "remote-session",
			workspaceId: "remote-workspace",
			commandBridgeNonce: "bridge-nonce",
		});
	});

	it("strips unknown transport material while rejecting incomplete identity", () => {
		expect(
			isRemoteHmuxStandalonePaneBindingV1({
				...target,
				authToken: "must-never-persist",
			}),
		).toBe(false);
		expect(
			normalizeRemoteHmuxStandalonePaneBindingV1({
				...target,
				authToken: "must-never-persist",
			}),
		).toEqual(target);
		expect(
			normalizeRemoteHmuxStandalonePaneBindingV1({
				...target,
				workspaceId: "",
			}),
		).toBeUndefined();
		expect(() =>
			remoteHmuxStandaloneBinding(
				"session",
				"workspace",
				"local",
				"bridge-nonce",
			),
		).toThrow(/exact remote runtime identity/);
	});

	it("does not switch the pane before an exact attach receipt", () => {
		const preparing = beginRemoteHmuxPaneTransition(
			source,
			"ssh-host-1",
			"create-1",
		);

		expect(activeRemoteHmuxPaneBinding(preparing)).toEqual(source);
		expect(cancelPreparingRemoteHmuxTransition(preparing)).toEqual(source);
		expect(
			acceptRemoteHmuxAttachReceipt(preparing, {
				createIdempotencyKey: "stale-create",
				targetBinding: target,
			}),
		).toBeUndefined();
		expect(
			acceptRemoteHmuxAttachReceipt(preparing, {
				createIdempotencyKey: "create-1",
				targetBinding: { ...target, hostId: "different-host" },
			}),
		).toBeUndefined();
		expect(activeRemoteHmuxPaneBinding(preparing)).toEqual(source);
	});

	it("keeps the remote binding across disconnect and returns only on remote exit", () => {
		const preparing = beginRemoteHmuxPaneTransition(
			source,
			"ssh-host-1",
			"create-1",
		);
		const attached = acceptRemoteHmuxAttachReceipt(preparing, {
			createIdempotencyKey: "create-1",
			targetBinding: target,
		});

		expect(attached).toBeDefined();
		if (!attached) throw new Error("expected exact attach receipt");
		expect(activeRemoteHmuxPaneBinding(attached)).toEqual(target);

		const reconnecting = markRemoteHmuxTransportDisconnected(attached);
		expect(reconnecting.phase).toBe("reconnecting");
		expect(activeRemoteHmuxPaneBinding(reconnecting)).toEqual(target);
		expect(isRemoteHmuxPaneTransitionV1(reconnecting)).toBe(true);

		const reattached = markRemoteHmuxTransportReattached(reconnecting);
		expect(activeRemoteHmuxPaneBinding(reattached)).toEqual(target);
		expect(completeRemoteHmuxExit(reattached)).toEqual(source);
	});

	it("persists a managed shell as the exact source restored after remote exit", () => {
		const managedSource = hmuxManagedBinding(
			"managed-local",
			"managed-workspace",
			undefined,
			undefined,
			{
				runnerPrincipal: "local",
				runnerInstance: "runner-local",
				channelEpoch: "3",
				hostInstanceId: "host-local",
				terminalEpoch: "terminal-local",
			},
		);
		const attached = acceptRemoteHmuxAttachReceipt(
			beginRemoteHmuxPaneTransition(managedSource, "ssh-host-1", "create-1"),
			{ createIdempotencyKey: "create-1", targetBinding: target },
		);

		expect(attached).toBeDefined();
		expect(isRemoteHmuxPaneTransitionV1(attached)).toBe(true);
		if (!attached) throw new Error("expected exact attach receipt");
		expect(completeRemoteHmuxExit(attached)).toEqual(managedSource);
	});

	it("fails closed on secret-bearing or mismatched persisted transitions", () => {
		const preparing = beginRemoteHmuxPaneTransition(
			source,
			"ssh-host-1",
			"create-1",
		);
		const attached = acceptRemoteHmuxAttachReceipt(preparing, {
			createIdempotencyKey: "create-1",
			targetBinding: target,
		});

		expect(attached).toBeDefined();
		expect(
			isRemoteHmuxPaneTransitionV1({
				...preparing,
				password: "must-never-persist",
			}),
		).toBe(false);
		expect(
			isRemoteHmuxPaneTransitionV1({
				...attached,
				targetBinding: { ...target, authToken: "must-never-persist" },
			}),
		).toBe(false);
	});
});
