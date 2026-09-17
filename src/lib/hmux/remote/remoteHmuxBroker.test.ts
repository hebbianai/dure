import { describe, expect, it } from "vitest";
import {
	isRemoteHmuxCatalogReceiptV1,
	isRemoteHmuxHostTrustV1,
	isRemoteHmuxManagedRehostReceiptV1,
	isRemoteHmuxManagedStopReceiptV1,
	parseRemoteHmuxManagedCreateAdvanceResolutionV1,
	planRemoteHmuxCatalogTarget,
	type RemoteHmuxCatalogReceiptV1,
	type RemoteHmuxHostTrustV1,
	selectRemoteHmuxSession,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import type { SshHostConfig } from "@/types";

const host: SshHostConfig = {
	id: "host-1",
	name: "build box",
	host: "build.example",
	port: 22,
	user: "developer",
	auth: "password",
	secretId: "ssh-host-1",
	password: "legacy-password-must-not-cross",
};

const trust: RemoteHmuxHostTrustV1 = {
	schemaVersion: 1,
	hostId: "host-1",
	hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
};

function receipt(): RemoteHmuxCatalogReceiptV1 {
	return {
		schemaVersion: 1,
		hostId: "host-1",
		sessions: [
			{
				sessionId: "session-1",
				sessionName: "shell",
				workspaceId: "workspace-1",
				sessionClass: "standalone",
				lifecycle: "ready",
				providerId: "shell",
				runnerPrincipal: "principal",
				runnerInstance: "instance",
				channelEpoch: "7",
				hostInstanceId: "host-instance",
				terminalEpoch: "terminal-epoch",
				supportedProtocol: {
					minimum: { major: 1, minor: 0 },
					maximum: { major: 1, minor: 0 },
				},
				capabilities: ["screen_snapshot"],
			},
		],
	};
}

describe("remote Hmux broker boundary", () => {
	it("resolves only registered hosts with enrolled SSH host-key trust", () => {
		expect(isRemoteHmuxHostTrustV1(trust, "host-1")).toBe(true);
		expect(planRemoteHmuxCatalogTarget([host], "host-1", trust)).toEqual({
			schemaVersion: 1,
			hostId: "host-1",
			host: "build.example",
			port: 22,
			user: "developer",
			auth: "password",
			secretId: "ssh-host-1",
			hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
		});
		expect(() => planRemoteHmuxCatalogTarget([], "host-1", trust)).toThrow(
			"remote_hmux_host_not_registered",
		);
		expect(() =>
			planRemoteHmuxCatalogTarget([host], "host-1", {
				...trust,
				hostKeyFingerprints: [],
			}),
		).toThrow("remote_hmux_host_untrusted");
		expect(() =>
			planRemoteHmuxCatalogTarget([{ ...host, port: 0 }], "host-1", trust),
		).toThrow("remote_hmux_target_invalid");
	});

	it("selects one exact ready session and fails closed on stale identity", () => {
		const catalog = receipt();
		expect(
			selectRemoteHmuxSession(catalog, {
				hostId: "host-1",
				sessionId: "session-1",
				workspaceId: "workspace-1",
				sessionClass: "standalone",
			}),
		).toEqual(catalog.sessions[0]);
		expect(() =>
			selectRemoteHmuxSession(catalog, {
				hostId: "host-1",
				sessionId: "session-1",
				workspaceId: "other-workspace",
			}),
		).toThrow("remote_hmux_session_not_found");
		expect(() =>
			selectRemoteHmuxSession(
				{
					...catalog,
					sessions: [{ ...catalog.sessions[0], lifecycle: "exited" }],
				},
				{
					hostId: "host-1",
					sessionId: "session-1",
					workspaceId: "workspace-1",
				},
			),
		).toThrow("remote_hmux_session_exited");
	});

	it("never copies a legacy password or transport capability into the request", () => {
		const target = planRemoteHmuxCatalogTarget([host], "host-1", trust);
		expect(target).not.toHaveProperty("password");
		expect(target).not.toHaveProperty("capabilityToken");
		expect(JSON.stringify(target)).not.toContain(
			"legacy-password-must-not-cross",
		);
	});

	it("accepts only exact, non-secret remote identity receipts", () => {
		expect(isRemoteHmuxCatalogReceiptV1(receipt(), "host-1")).toBe(true);
		expect(isRemoteHmuxCatalogReceiptV1(receipt(), "other-host")).toBe(false);
		expect(
			isRemoteHmuxCatalogReceiptV1({
				...receipt(),
				sessions: [
					{
						...receipt().sessions[0],
						capabilityToken: "must-not-persist",
					},
				],
			}),
		).toBe(false);
		expect(
			isRemoteHmuxCatalogReceiptV1({
				...receipt(),
				sessions: [{ ...receipt().sessions[0], channelEpoch: "-1" }],
			}),
		).toBe(false);
		expect(
			isRemoteHmuxCatalogReceiptV1({
				...receipt(),
				sessions: [
					{
						...receipt().sessions[0],
						retirementPolicy: {
							kind: "after_graceful_last_client_departure_v1",
							gracePeriodMs: 2_000,
						},
					},
				],
			}),
		).toBe(true);
		expect(
			isRemoteHmuxCatalogReceiptV1({
				...receipt(),
				sessions: [
					{
						...receipt().sessions[0],
						launchProgram: "zsh",
						hostLiveness: "live",
						gatewayBuildId: "0.1.4+remote.release",
					},
				],
			}),
		).toBe(true);
		expect(
			isRemoteHmuxCatalogReceiptV1({
				...receipt(),
				sessions: [
					{
						...receipt().sessions[0],
						hostLiveness: "maybe",
					},
				],
			}),
		).toBe(false);
		expect(
			isRemoteHmuxCatalogReceiptV1({
				...receipt(),
				sessions: [
					{
						...receipt().sessions[0],
						retirementPolicy: {
							kind: "after_graceful_last_client_departure_v1",
							gracePeriodMs: 999,
						},
					},
				],
			}),
		).toBe(false);
	});

	it("parses only closed advance states with the exact SSH generation", () => {
		const expected = {
			idempotencyKey: "create-1",
			bridgeNonce: "bridge-1",
			sessionId: "session-1",
			workspaceId: "workspace-1",
			providerId: "codex",
		};
		const current = {
			state: "current",
			receipt: {
				idempotencyKey: expected.idempotencyKey,
				bridgeNonce: expected.bridgeNonce,
				outcome: "created",
				session: {
					...receipt().sessions[0],
					sessionClass: "managed",
					providerId: expected.providerId,
					futurePresentationState: { revision: 2 },
				},
				futureReceiptDiagnostic: { revision: 2 },
			},
		};

		expect(
			parseRemoteHmuxManagedCreateAdvanceResolutionV1(current, expected),
		).toMatchObject({
			state: "current",
			receipt: {
				idempotencyKey: expected.idempotencyKey,
				session: { sessionId: expected.sessionId },
			},
		});
		const advanced = {
			state: "advanced",
			receipt: {
				...current.receipt,
				idempotencyKey: "create-successor",
				session: {
					...current.receipt.session,
					sessionId: "session-successor",
				},
			},
		};
		expect(
			parseRemoteHmuxManagedCreateAdvanceResolutionV1(advanced, expected),
		).toMatchObject({
			state: "advanced",
			receipt: {
				idempotencyKey: "create-successor",
				session: { sessionId: "session-successor" },
			},
		});
		expect(
			parseRemoteHmuxManagedCreateAdvanceResolutionV1(
				{
					...advanced,
					receipt: {
						...advanced.receipt,
						idempotencyKey: expected.idempotencyKey,
					},
				},
				expected,
			),
		).toBeUndefined();
		expect(
			parseRemoteHmuxManagedCreateAdvanceResolutionV1(
				{
					state: "normalize_existing",
					existing: current.receipt,
				},
				expected,
			),
		).toBeUndefined();
	});

	it("accepts a managed stop receipt only for the exact generation", () => {
		const expected = {
			stopId: "stop-1",
			sessionId: "session-1",
			workspaceId: "workspace-1",
			runnerPrincipal: "principal-1",
			runnerInstance: "runner-1",
			channelEpoch: "7",
			hostInstanceId: "host-instance",
			terminalEpoch: "terminal-epoch",
		};
		const stop = {
			schema: "hmux-managed-stop-v1",
			schemaVersion: 2,
			...expected,
			channelEpoch: 7,
			outcome: "stopped",
			exitReason: "managed_provider_stop",
		};
		expect(isRemoteHmuxManagedStopReceiptV1(stop, expected)).toBe(true);
		expect(
			isRemoteHmuxManagedStopReceiptV1(
				{ ...stop, runnerInstance: "replacement-runner" },
				expected,
			),
		).toBe(false);
		expect(
			isRemoteHmuxManagedStopReceiptV1(
				{ ...stop, terminalEpoch: "replacement-epoch" },
				expected,
			),
		).toBe(false);
		expect(
			isRemoteHmuxManagedStopReceiptV1(
				{ ...stop, capabilityToken: "must-not-cross" },
				expected,
			),
		).toBe(false);
	});

	it("accepts the journaled generations without retry hint equality", () => {
		const sourceFence = {
			runnerPrincipal: "principal-source",
			runnerInstance: "runner-source",
			channelEpoch: "7",
			hostInstanceId: "host-source",
			terminalEpoch: "terminal-source",
		};
		const expected = {
			operationId: "operation-1",
			bridgeNonce: "bridge-1",
			sourceSessionId: "session-source",
			sourceWorkspaceId: "workspace-1",
		};
		const rehostReceipt = {
			operationId: "operation-1",
			bridgeNonce: "bridge-1",
			conversationId: "conversation-1",
			launchReference: "codex-target",
			replayed: true,
			sourceStopReceipt: {
				stopId: "managed_rehost_stop_operation-1",
				sessionId: "session-source",
				workspaceId: "workspace-1",
				...sourceFence,
				outcome: "stopped",
				exitReason: "managed_provider_stop",
			},
			replacement: {
				idempotencyKey: "replacement-1",
				sessionId: "session-replacement",
				workspaceId: "workspace-1",
				providerId: "codex",
				permissionMode: "default",
				runnerPrincipal: "principal-target",
				runnerInstance: "runner-target",
				channelEpoch: "8",
				hostInstanceId: "host-target",
				terminalEpoch: "terminal-target",
			},
		};

		for (const conversationId of [null, undefined, ""]) {
			expect(
				isRemoteHmuxManagedRehostReceiptV1(
					{ ...rehostReceipt, conversationId },
					expected,
				),
			).toBe(conversationId === null);
		}
		expect(isRemoteHmuxManagedRehostReceiptV1(rehostReceipt, expected)).toBe(
			true,
		);
		expect(
			isRemoteHmuxManagedRehostReceiptV1(
				{ ...rehostReceipt, launchReference: "../other" },
				expected,
			),
		).toBe(false);
		expect(
			isRemoteHmuxManagedRehostReceiptV1(
				{
					...rehostReceipt,
					sourceStopReceipt: {
						...rehostReceipt.sourceStopReceipt,
						stopId: "managed_rehost_stop_other-operation",
					},
				},
				expected,
			),
		).toBe(false);
		expect(
			isRemoteHmuxManagedRehostReceiptV1(
				{
					...rehostReceipt,
					sourceStopReceipt: {
						...rehostReceipt.sourceStopReceipt,
						terminalEpoch: "terminal-other",
					},
				},
				expected,
			),
		).toBe(true);
		expect(
			isRemoteHmuxManagedRehostReceiptV1(
				{
					...rehostReceipt,
					replacement: {
						...rehostReceipt.replacement,
						capabilityToken: "must-not-cross",
					},
				},
				expected,
			),
		).toBe(false);
	});
});
