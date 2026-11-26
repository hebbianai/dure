import { describe, expect, it, vi } from "vitest";
import type { DureBackendProfileSummary } from "@/lib/ipc/dureBackendProfiles";
import { resolveSshHostDureBackendRouteAuthority } from "@/lib/ipc/dureBackendProfiles";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type { SshHostConfig } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function route(
	profileId: string,
	remote?: { host: string; port: number; user: string },
): DureBackendRouteAuthorityV1 {
	return {
		schemaVersion: 1,
		profileId,
		revision: `sha256:${"a".repeat(64)}`,
		backend: { id: `backend-${profileId}`, generation: "generation-a" },
		target: remote
			? { source: "ssh", hostId: profileId, remote }
			: { source: "local", hostId: "local" },
	};
}

const hosts: SshHostConfig[] = [
	{
		id: "host-a",
		name: "A",
		host: "a.example.test",
		port: 22,
		user: "dure",
		auth: "auto",
	},
	{
		id: "host-b",
		name: "B",
		host: "b.example.test",
		port: 2222,
		user: "dure",
		auth: "auto",
	},
];

function runtime(
	profiles: DureBackendProfileSummary[],
	routes: Record<string, DureBackendRouteAuthorityV1 | Error>,
) {
	return {
		profiles: async () => profiles,
		resolve: vi.fn(async (profileId: string | undefined) => {
			const resolved = routes[profileId ?? ""];
			if (!resolved || resolved instanceof Error) throw resolved;
			return resolved;
		}),
	};
}

describe("SSH Host backend routes", () => {
	it("finds the SSH profile whose transport reaches the Host", async () => {
		const serving = route("profile-b", {
			host: "b.example.test",
			port: 2222,
			user: "dure",
		});
		const backends = runtime(
			[
				{ id: "local", default: true, kind: "local" },
				{ id: "profile-a", default: false, kind: "ssh" },
				{ id: "profile-b", default: false, kind: "ssh" },
				{ id: "profile-broken", default: false, kind: "ssh" },
			],
			{
				local: route("local"),
				"profile-a": route("profile-a", {
					host: "a.example.test",
					port: 22,
					user: "dure",
				}),
				"profile-b": serving,
				"profile-broken": new Error("backend_transport_profile_invalid"),
			},
		);

		await expect(
			resolveSshHostDureBackendRouteAuthority("host-b", hosts, backends),
		).resolves.toEqual(serving);
		// Only SSH profiles are asked for a route.
		expect(backends.resolve).not.toHaveBeenCalledWith("local");
	});

	it("finds nothing for an unserved Host or a Host two profiles reach", async () => {
		const twoForA = runtime(
			[
				{ id: "profile-a", default: true, kind: "ssh" },
				{ id: "profile-a2", default: false, kind: "ssh" },
			],
			{
				"profile-a": route("profile-a", {
					host: "a.example.test",
					port: 22,
					user: "dure",
				}),
				"profile-a2": route("profile-a2", {
					host: "a.example.test",
					port: 22,
					user: "dure",
				}),
			},
		);

		await expect(
			resolveSshHostDureBackendRouteAuthority("host-b", hosts, twoForA),
		).resolves.toBeUndefined();
		await expect(
			resolveSshHostDureBackendRouteAuthority("host-a", hosts, twoForA),
		).resolves.toBeUndefined();
	});
});
