import { describe, expect, it, vi } from "vitest";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type { AccountProfile } from "@/types";
import { resolveCliRunAccount } from "./cliRunAccount";

function fixture() {
	const accounts = ["work", "personal"].map(
		(id) =>
			({
				id,
				provider: "claude",
				dir: `/profiles/claude-${id}`,
				name: id,
			}) as AccountProfile,
	);
	const state = { accounts, activeAccounts: { claude: "work" } };
	const route = { profileId: "local" } as DureBackendRouteAuthorityV1;
	const dependencies = {
		readState: () => state,
		resolveRoute: vi.fn(async () => route),
		register: vi.fn(async ({ referenceId }: { referenceId: string }) => ({
			kind: "credential_reference" as const,
			reference_id: referenceId,
			credential_generation: "generation-1",
		})),
	};
	return { state, dependencies, route };
}
describe("CLI Run account selection", () => {
	it.each([
		{ account: undefined, expected: "work" },
		{ account: "personal", expected: "personal" },
	])(
		"registers the selected account on the exact backend: $expected",
		async ({ account, expected }) => {
			const f = fixture();
			const result = await resolveCliRunAccount(
				{ providerId: "claude", backendProfileId: "local", account },
				f.dependencies,
			);
			expect(result.executionProfile).toEqual({
				kind: "credential_reference",
				reference_id: expected,
				credential_generation: "generation-1",
			});
			expect(f.dependencies.register).toHaveBeenCalledWith(
				{
					providerId: "claude",
					referenceId: expected,
					profileDirectoryName: `claude-${expected}`,
				},
				{ profileId: "local", routeAuthority: f.route },
			);
		},
	);
	it("pins provider default without registering the active account", async () => {
		const f = fixture();
		expect(
			(
				await resolveCliRunAccount(
					{
						providerId: "claude",
						backendProfileId: "local",
						account: "default",
					},
					f.dependencies,
				)
			).executionProfile,
		).toEqual({ kind: "provider_default" });
		expect(f.dependencies.register).not.toHaveBeenCalled();
	});
	it("refuses a missing selected account without falling back", async () => {
		const f = fixture();
		f.state.activeAccounts.claude = "removed";
		await expect(
			resolveCliRunAccount(
				{ providerId: "claude", backendProfileId: "local" },
				f.dependencies,
			),
		).rejects.toThrow("unavailable");
		expect(f.dependencies.register).not.toHaveBeenCalled();
	});
	it("snapshots the account before backend resolution yields", async () => {
		const f = fixture();
		f.dependencies.resolveRoute.mockImplementation(async () => {
			f.state.activeAccounts.claude = "personal";
			return f.route;
		});
		expect(
			(
				await resolveCliRunAccount(
					{ providerId: "claude", backendProfileId: "local" },
					f.dependencies,
				)
			).executionProfile,
		).toMatchObject({ reference_id: "work" });
	});
});
