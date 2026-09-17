import { describe, expect, it, vi } from "vitest";
import {
	providerCatalogSource,
	agentProviderCatalogSource,
} from "./providerModelCatalogSource";
import { readProviderCatalog } from "@/lib/ipc/providerCatalog";
import type { Agent } from "@/types";

vi.mock("@/lib/ipc/providerCatalog", () => ({
	readProviderCatalog: vi.fn().mockResolvedValue([]),
}));

describe("provider catalog scope", () => {
	it("queries the selected backend and credential without sending local paths", async () => {
		const source = providerCatalogSource("codex", "remote-1", {
			id: "acc-work",
			provider: "codex",
			name: "Work",
			dir: "/local/accounts/codex-work",
		});
		await source.load();
		expect(readProviderCatalog).toHaveBeenLastCalledWith({
			providerId: "codex",
			profileId: "remote-1",
			credentialProfile: {
				referenceId: "acc-work",
				profileDirectoryName: "codex-work",
			},
		});
	});
	it("does not silently query default credentials when a named account is unavailable", async () => {
		const agent = {
			id: "agent-a",
			provider: "codex",
			projectId: "project-a",
			executionProfile: {
				kind: "credential_reference",
				reference_id: "missing",
				credential_generation: "generation-1",
			},
			runtimeBinding: {
				runtime: "hmux_managed_v1",
				source: "local",
				backendProfileId: "local",
			},
		} as Agent;
		await expect(
			agentProviderCatalogSource(
				agent,
				{
					id: "project-a",
					kind: "local",
					name: "A",
					path: "/repo",
					isRepo: true,
				},
				[],
			).load(),
		).rejects.toThrow("scope_unavailable");
	});
	it("reports malformed account paths on open without crashing pane rendering", async () => {
		const source = providerCatalogSource("codex", "local", {
			id: "acc-bad",
			provider: "codex",
			name: "Bad",
			dir: "/unsafe",
		});
		await expect(source.load()).rejects.toThrow("untrusted");
	});
});
