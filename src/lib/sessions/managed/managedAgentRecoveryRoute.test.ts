import { describe, expect, it, vi } from "vitest";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	managedRecoveryRouteIdentity,
	parseManagedRecoveryRouteIdentity,
	resolveManagedRecoveryRouteAuthority,
} from "@/lib/sessions/managed/managedAgentRecoveryRoute";
import { managedBindingFixture, stopFenceFixture } from "@/test/agentFixtures";

function route(
	revision = `sha256:${"a".repeat(64)}`,
): DureBackendRouteAuthorityV1 {
	return {
		schemaVersion: 1,
		profileId: "backend-profile",
		revision,
		backend: { id: "backend-1", generation: "generation-1" },
		target: { source: "local", hostId: "local" },
	};
}

function binding() {
	return managedBindingFixture({
		sessionId: "session-source",
		workspaceId: "workspace-1",
		backendProfileId: "backend-profile",
		stopFence: stopFenceFixture({ terminalEpoch: "terminal-source" }),
	});
}

describe("managed recovery route identity", () => {
	it("fits the Hmux operation-id contract and binds source, profile, and revision", () => {
		const source = binding();
		const identity = managedRecoveryRouteIdentity(source, route());

		expect(identity.recoveryId).toMatch(
			/^recovery4_[0-9a-f]{16}_[0-9a-f]{64}$/,
		);
		expect(new TextEncoder().encode(identity.recoveryId)).toHaveLength(91);
		expect(identity.recoveryId.length).toBeLessThanOrEqual(128);
		expect(
			parseManagedRecoveryRouteIdentity(source, identity.recoveryId),
		).toEqual({
			recoveryId: identity.recoveryId,
			revision: route().revision,
		});
		expect(
			parseManagedRecoveryRouteIdentity(
				{ ...source, sessionId: "another-session" },
				identity.recoveryId,
			),
		).toBeUndefined();
		expect(
			parseManagedRecoveryRouteIdentity(
				{ ...source, backendProfileId: "another-profile" },
				identity.recoveryId,
			),
		).toBeUndefined();
		expect(
			parseManagedRecoveryRouteIdentity(
				{
					...source,
					stopFence: source.stopFence
						? { ...source.stopFence, terminalEpoch: "another-terminal" }
						: undefined,
				},
				identity.recoveryId,
			),
		).toBeUndefined();
	});

	it("treats legacy v3 identifiers as lacking a restart route commitment", () => {
		expect(
			parseManagedRecoveryRouteIdentity(binding(), "recovery_0123456789abcdef"),
		).toBeUndefined();
	});

	it("accepts a materialized candidate only after exact revision equality", async () => {
		const source = binding();
		const authority = route();
		const operationId = managedRecoveryRouteIdentity(
			source,
			authority,
		).recoveryId;
		const resolveExact = vi.fn(async () => authority);

		await expect(
			resolveManagedRecoveryRouteAuthority(source, operationId, resolveExact),
		).resolves.toEqual(authority);
		expect(resolveExact).toHaveBeenCalledWith("backend-profile");

		const changed = route(`sha256:${"b".repeat(64)}`);
		await expect(
			resolveManagedRecoveryRouteAuthority(
				source,
				operationId,
				async () => changed,
			),
		).resolves.toBeUndefined();
	});
});
