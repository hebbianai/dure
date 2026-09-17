import { describe, expect, it } from "vitest";
import {
	matchRemoteHmuxHost,
	parseRemoteHmuxShellRequest,
} from "@/lib/hmux/remote/remoteHmuxShellRequest";
import type { SshHostConfig } from "@/types";

const rts: SshHostConfig = {
	id: "host-rts",
	name: "rts",
	host: "211.181.122.124",
	port: 22,
	user: "rts",
	auth: "auto",
};

describe("remote Hmux shell request", () => {
	it("accepts a bounded exact source and preserves terminal geometry", () => {
		expect(
			parseRemoteHmuxShellRequest({
				sourceSessionId: "standalone-local",
				sourceWorkspaceId: "workspace-local",
				argv: ["rts@211.181.122.124"],
				destination: { host: "211.181.122.124", user: "rts" },
				initialColumns: 155,
				initialRows: 42,
			}),
		).toEqual({
			sourceSessionId: "standalone-local",
			sourceWorkspaceId: "workspace-local",
			argv: ["rts@211.181.122.124"],
			destination: { host: "211.181.122.124", user: "rts" },
			initialColumns: 155,
			initialRows: 42,
		});
	});

	it("fails closed on malformed identity, destination, or argv", () => {
		const base = {
			sourceSessionId: "standalone-local",
			sourceWorkspaceId: "workspace-local",
			argv: ["rts"],
			destination: { host: "rts" },
		};
		expect(() =>
			parseRemoteHmuxShellRequest({ ...base, sourceSessionId: "../escape" }),
		).toThrow();
		expect(() =>
			parseRemoteHmuxShellRequest({
				...base,
				destination: { host: "rts", port: 70_000 },
			}),
		).toThrow();
		expect(() =>
			parseRemoteHmuxShellRequest({ ...base, argv: ["rts\0command"] }),
		).toThrow();
	});

	it.each([
		["-L", "8080:localhost:80", "rts@211.181.122.124"],
		["-J", "jump", "rts@211.181.122.124"],
		["-F", "/tmp/config", "rts@211.181.122.124"],
		["-i", "/tmp/key", "rts@211.181.122.124"],
		["-o", "ProxyCommand=custom", "rts@211.181.122.124"],
		["-N", "rts@211.181.122.124"],
		["-s", "rts@211.181.122.124", "sftp"],
		["rts@211.181.122.124", "uname", "-a"],
	])(
		"rejects unsupported argv even with a valid destination: %j",
		(...argv) => {
			expect(() =>
				parseRemoteHmuxShellRequest({
					sourceSessionId: "standalone-local",
					sourceWorkspaceId: "workspace-local",
					argv,
					destination: { host: "211.181.122.124", user: "rts" },
				}),
			).toThrow();
		},
	);

	it.each([
		{ host: "other.example", user: "rts", port: 2222 },
		{ host: "211.181.122.124", user: "other", port: 2222 },
		{ host: "211.181.122.124", user: "rts", port: 22 },
		{ host: "211.181.122.124", user: "rts" },
	])(
		"rejects destination disagreement with original argv: %j",
		(destination) => {
			expect(() =>
				parseRemoteHmuxShellRequest({
					sourceSessionId: "standalone-local",
					sourceWorkspaceId: "workspace-local",
					argv: ["-p2222", "rts@211.181.122.124"],
					destination,
				}),
			).toThrow();
		},
	);

	it.each([
		["-p", "2222", "-lrts", "211.181.122.124"],
		["rts@211.181.122.124", "-p2222"],
		["-p2222", "--", "rts@211.181.122.124"],
	])("preserves supported structural option forms: %j", (...argv) => {
		const destination = { host: "211.181.122.124", user: "rts", port: 2222 };
		expect(
			parseRemoteHmuxShellRequest({
				sourceSessionId: "standalone-local",
				sourceWorkspaceId: "workspace-local",
				argv,
				destination,
			}),
		).toMatchObject({ argv, destination });
	});

	it.each([
		{ argv: ["rts"], destination: { host: "rts" } },
		{
			argv: ["-p2222", "rts@[2001:db8::1]"],
			destination: { host: "2001:db8::1", user: "rts", port: 2222 },
		},
	])(
		"preserves existing alias and IPv6 request forms: %j",
		({ argv, destination }) => {
			expect(
				parseRemoteHmuxShellRequest({
					sourceSessionId: "standalone-local",
					sourceWorkspaceId: "workspace-local",
					argv,
					destination,
				}),
			).toMatchObject({ argv, destination });
		},
	);

	it("matches only one exact registered host and respects explicit fences", () => {
		expect(
			matchRemoteHmuxHost([rts], {
				host: "211.181.122.124",
				user: "rts",
			}),
		).toEqual(rts);
		expect(matchRemoteHmuxHost([rts], { host: "rts" })).toEqual(rts);
		expect(
			matchRemoteHmuxHost([rts], {
				host: "211.181.122.124",
				user: "other",
			}),
		).toBeUndefined();
		expect(
			matchRemoteHmuxHost([rts], {
				host: "211.181.122.124",
				port: 2222,
			}),
		).toBeUndefined();
		expect(
			matchRemoteHmuxHost(
				[rts, { ...rts, id: "host-rts-duplicate", name: "duplicate" }],
				{ host: "211.181.122.124" },
			),
		).toBeUndefined();
	});

	it("does not reinterpret a literal address as a saved non-default port", () => {
		const nonDefault = { ...rts, port: 2222 };
		expect(
			matchRemoteHmuxHost([nonDefault], { host: "211.181.122.124" }),
		).toBeUndefined();
		expect(matchRemoteHmuxHost([nonDefault], { host: "rts" })).toEqual(
			nonDefault,
		);
	});
});
