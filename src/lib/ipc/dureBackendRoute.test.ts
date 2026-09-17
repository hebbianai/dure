import { describe, expect, it, vi } from "vitest";
import {
	type DureBackendRouteAuthorityV1,
	parseDureBackendRouteAuthority,
	resolveExactDureBackendSshHost,
} from "@/lib/ipc/dureBackendRoute";
import type { SshHostConfig } from "@/types";

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

const authority: DureBackendRouteAuthorityV1 = {
	schemaVersion: 1,
	profileId: "backend-profile-a",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend-a", generation: "generation-a" },
	target: {
		source: "ssh",
		hostId: "backend-profile-a",
		remote: { host: "a.example.test", port: 2222, user: "dure" },
	},
};

const hosts: SshHostConfig[] = [
	{
		id: "project-host-a",
		name: "A",
		host: "a.example.test",
		port: 2222,
		user: "dure",
		auth: "auto",
	},
	{
		id: "project-host-b",
		name: "B",
		host: "b.example.test",
		port: 22,
		user: "dure",
		auth: "auto",
	},
];

describe("Dure backend route authority", () => {
	it("parses one versioned non-secret local or SSH authority", () => {
		expect(parseDureBackendRouteAuthority(authority)).toEqual(authority);
		expect(
			parseDureBackendRouteAuthority({
				...authority,
				revision: "sha256:short",
			}),
		).toBeUndefined();
		expect(
			parseDureBackendRouteAuthority({
				...authority,
				target: { ...authority.target, unexpected: true },
			}),
		).toEqual(authority);
	});

	it("maps a backend profile id by exact coordinates rather than id equality", () => {
		expect(
			resolveExactDureBackendSshHost(authority, "project-host-a", hosts, fail),
		).toBe(hosts[0]);
	});

	it("rejects profile A plus project host B before an SSH preflight can run", () => {
		const preflight = vi.fn();
		expect(() => {
			const host = resolveExactDureBackendSshHost(
				authority,
				"project-host-b",
				hosts,
				fail,
			);
			preflight(host);
		}).toThrow(
			expect.objectContaining({ code: "client_backend_host_mismatch" }),
		);
		expect(preflight).not.toHaveBeenCalled();
	});
});
