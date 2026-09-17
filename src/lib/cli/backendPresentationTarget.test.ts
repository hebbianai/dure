import { describe, expect, it } from "vitest";
import {
	parseBackendPresentationTarget,
	resolveBackendPresentationSshHost,
} from "@/lib/cli/backendPresentationTarget";
import type { SshHostConfig } from "@/types";

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

const host: SshHostConfig = {
	id: "registered-host",
	name: "Remote",
	host: "dev.example.test",
	port: 2222,
	user: "dev",
	auth: "auto",
};

describe("backend presentation target", () => {
	it("parses one normalized SSH execution target", () => {
		expect(
			parseBackendPresentationTarget(
				{
					source: "ssh",
					hostId: "remote-a",
					remote: { host: "dev.example.test", port: 2222, user: "dev" },
				},
				fail,
			),
		).toEqual({
			source: "ssh",
			hostId: "remote-a",
			remote: { host: "dev.example.test", port: 2222, user: "dev" },
		});
	});

	it("uses an exact id only when its SSH coordinates still agree", () => {
		const target = {
			source: "ssh" as const,
			hostId: host.id,
			remote: { host: host.host, port: host.port, user: host.user },
		};
		expect(resolveBackendPresentationSshHost(target, [host], fail)).toBe(host);
		expect(() =>
			resolveBackendPresentationSshHost(
				{ ...target, remote: { ...target.remote, port: 22 } },
				[host],
				fail,
			),
		).toThrow(
			expect.objectContaining({ code: "client_backend_host_mismatch" }),
		);
	});

	it("maps a profile id to one unique registered host by coordinates", () => {
		const target = {
			source: "ssh" as const,
			hostId: "backend-profile-a",
			remote: { host: host.host, port: host.port, user: host.user },
		};
		expect(resolveBackendPresentationSshHost(target, [host], fail)).toBe(host);
		expect(() =>
			resolveBackendPresentationSshHost(
				target,
				[host, { ...host, id: "registered-host-2" }],
				fail,
			),
		).toThrow(
			expect.objectContaining({ code: "client_backend_host_ambiguous" }),
		);
	});
});
