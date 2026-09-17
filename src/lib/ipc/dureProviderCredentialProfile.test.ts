import { describe, expect, it, vi } from "vitest";
import {
	registerDureProviderCredentialProfile,
	supportsDureProviderCredentialSpawn,
} from "@/lib/ipc/dureProviderCredentialProfile";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

function envelope(profile: Record<string, unknown>) {
	return {
		schemaVersion: 1,
		backendId: "dure-local",
		backendGeneration: "generation-1",
		routeAuthority: testDureBackendRouteAuthority("dure-local", "generation-1"),
		result: { schemaVersion: 1, profile },
	};
}

describe("registerDureProviderCredentialProfile", () => {
	it("admits credential-backed Claude and Codex runs only", () => {
		expect(supportsDureProviderCredentialSpawn("claude")).toBe(true);
		expect(supportsDureProviderCredentialSpawn("codex")).toBe(true);
		expect(supportsDureProviderCredentialSpawn("kimi")).toBe(false);
	});

	it("returns the exact opaque generation and never sends an absolute path", async () => {
		const routeAuthority = testDureBackendRouteAuthority(
			"dure-local",
			"generation-1",
		);
		const invoke = vi.fn().mockResolvedValue(
			envelope({
				schemaVersion: 1,
				providerId: "claude",
				referenceId: "acc-work",
				credentialGeneration: "credential-v1-generation",
			}),
		);

		await expect(
			registerDureProviderCredentialProfile(
				{
					providerId: "claude",
					referenceId: "acc-work",
					profileDirectoryName: "claude-work",
				},
				{ routeAuthority, invokeCommand: invoke },
			),
		).resolves.toEqual({
			kind: "credential_reference",
			reference_id: "acc-work",
			credential_generation: "credential-v1-generation",
		});
		expect(invoke).toHaveBeenCalledWith(
			"dure_backend_request",
			expect.objectContaining({
				route: { kind: "exact", authority: routeAuthority },
				operation: "provider_credential_profile.register",
				body: expect.objectContaining({
					profileDirectoryName: "claude-work",
				}),
			}),
		);
		expect(JSON.stringify(invoke.mock.calls)).not.toContain("/accounts/");
	});

	it("rejects a mismatched receipt instead of weakening the credential fence", async () => {
		const invoke = vi.fn().mockResolvedValue(
			envelope({
				schemaVersion: 1,
				providerId: "claude",
				referenceId: "acc-other",
				credentialGeneration: "credential-v1-other",
				extra: true,
			}),
		);

		await expect(
			registerDureProviderCredentialProfile(
				{
					providerId: "claude",
					referenceId: "acc-work",
					profileDirectoryName: "claude-work",
				},
				{ invokeCommand: invoke },
			),
		).rejects.toMatchObject({
			code: "provider_credential_profile_response_invalid",
		});
	});

	it("rejects a wrong-version registration result", async () => {
		const response = envelope({
			schemaVersion: 1,
			providerId: "claude",
			referenceId: "acc-work",
			credentialGeneration: "credential-v1-generation",
		});
		response.result.schemaVersion = 2;

		await expect(
			registerDureProviderCredentialProfile(
				{
					providerId: "claude",
					referenceId: "acc-work",
					profileDirectoryName: "claude-work",
				},
				{ invokeCommand: vi.fn().mockResolvedValue(response) },
			),
		).rejects.toMatchObject({
			code: "provider_credential_profile_response_invalid",
		});
	});

	it("rejects an opaque provider launch reference before registration", async () => {
		const invoke = vi.fn();

		await expect(
			registerDureProviderCredentialProfile(
				{
					providerId: "claude",
					referenceId: "credential+profile",
					profileDirectoryName: "claude-work",
				},
				{ invokeCommand: invoke },
			),
		).rejects.toMatchObject({
			code: "provider_credential_profile_response_invalid",
		});
		expect(invoke).not.toHaveBeenCalled();
	});
});
