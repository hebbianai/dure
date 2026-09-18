import { expect, it, vi } from "vitest";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { createAccountRecoveryClient } from "./dureAccountRecovery";

const profile = {
	schemaVersion: 1,
	providerId: "codex",
	referenceId: "shared",
	credentialGeneration: "generation-a",
};
const authority = testDureBackendRouteAuthority("team", "process-1", "team");
function envelope(result: Record<string, unknown>) {
	return {
		schemaVersion: 1,
		backendId: "team",
		backendGeneration: "process-1",
		routeAuthority: authority,
		result: { schemaVersion: 1, ...result },
	};
}
it("reads the server pool and writes only against the observed route and revision", async () => {
	const invoke = vi
		.fn()
		.mockResolvedValueOnce(envelope({ policy: null, profiles: [profile] }))
		.mockResolvedValueOnce(
			envelope({
				policy: {
					schemaVersion: 1,
					providerId: "codex",
					revision: 1,
					enabled: true,
					accounts: [{ profile, name: "Team" }],
					activatedAtMs: 100,
					updatedAtMs: 100,
				},
			}),
		);
	const client = createAccountRecoveryClient("team", invoke);
	const snapshot = await client.get("codex");
	const policy = await client.put(
		{
			providerId: "codex",
			enabled: true,
			expectedRevision: 0,
			idempotencyKey: "request-a",
			accounts: [{ profile: snapshot.profiles[0]!, name: "Team" }],
		},
		snapshot.routeAuthority,
	);
	expect(policy.revision).toBe(1);
	expect(invoke.mock.calls[1]?.[1]).toMatchObject({
		operation: "provider_recovery.put",
		route: { kind: "exact", authority },
		body: { expectedRevision: 0, idempotencyKey: "request-a" },
	});
});
it("rejects a different provider snapshot rather than offering its profiles", async () => {
	const invoke = vi
		.fn()
		.mockResolvedValue(
			envelope({
				policy: null,
				profiles: [{ ...profile, providerId: "claude" }],
			}),
		);
	await expect(
		createAccountRecoveryClient("team", invoke).get("codex"),
	).rejects.toMatchObject({ code: "provider_recovery_response_invalid" });
});
