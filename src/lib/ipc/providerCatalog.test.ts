import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readProviderCatalog } from "./providerCatalog";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe("provider catalog transport", () => {
	it("accepts newly reported models on the selected backend route", async () => {
		vi.mocked(invoke).mockResolvedValue({
			schemaVersion: 1,
			backendId: "backend-1",
			backendGeneration: "generation-1",
			routeAuthority: testDureBackendRouteAuthority(
				"backend-1",
				"generation-1",
			),
			result: {
				schemaVersion: 1,
				models: [
					{
						value: "next[1m]",
						displayName: "Next",
						supportsEffort: true,
						supportedEffortLevels: ["deep"],
					},
				],
			},
		});
		const models = await readProviderCatalog({
			providerId: "codex",
			profileId: "selected",
		});
		expect(models[0]).toMatchObject({
			value: "next[1m]",
			supportedEffortLevels: ["deep"],
		});
		expect(invoke).toHaveBeenCalledWith(
			"dure_backend_request",
			expect.objectContaining({
				operation: "provider_catalog.read",
				route: { kind: "selected", profileId: "selected" },
				body: {
					schemaVersion: 1,
					providerId: "codex",
					credentialProfile: null,
				},
			}),
		);
	});
	it("propagates discovery failures instead of substituting a curated list", async () => {
		vi.mocked(invoke).mockRejectedValue(new Error("offline"));
		await expect(
			readProviderCatalog({ providerId: "codex", profileId: "local" }),
		).rejects.toThrow();
	});
});
