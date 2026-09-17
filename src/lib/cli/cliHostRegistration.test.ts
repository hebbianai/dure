// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshConfigScan } from "@/types";

const scan: SshConfigScan = {
	defaultUser: "local-user",
	files: [
		{
			path: "/home/local/.ssh/config",
			displayPath: "~/.ssh/config",
			hosts: [
				{
					alias: "ec2-106",
					hostName: "example.test",
					user: "ec2-user",
					identityFile: "~/.ssh/key.pem",
				},
			],
		},
	],
};

async function boot() {
	vi.resetModules();
	const store = await import("@/store");
	await store.rehydrateAppStoreFromDurableStorage();
	const { handleCliHostRegistration } = await import("./cliHostRegistration");
	const lifecycle = await import("@/lib/ssh/sshCredentialLifecycle");
	const routes = await import("@/lib/ssh/sshConfigRouteLifecycle");
	const deps = {
		isMainWindow: () => true,
		claim: vi.fn(async () => true),
		scan: vi.fn(async () => scan),
		registerConfig: vi.fn(routes.registerSshConfigHostDurably),
		create: vi.fn(lifecycle.createSshHostDurably),
	};
	return {
		store,
		deps,
		lifecycle,
		add: (params: Record<string, unknown>) =>
			handleCliHostRegistration(params, "registration", deps),
	};
}

describe("CLI SSH registration through the GUI durable owner", () => {
	let run: Awaited<ReturnType<typeof boot>>;
	beforeEach(async () => {
		localStorage.clear();
		run = await boot();
	});
	afterEach(async () => {
		await run.store.durableAppStorage.flush();
		localStorage.clear();
		vi.resetModules();
	});

	it("persists config authentication and reuses the same Host after a fresh store boot", async () => {
		const first = await run.add({ sshConfigAlias: "EC2-106" });
		expect(first).toMatchObject({
			ok: true,
			registration: {
				created: true,
				persisted: true,
				host: {
					name: "ec2-106",
					host: "example.test",
					user: "ec2-user",
					port: 22,
					auth: "key",
					keyPath: "~/.ssh/key.pem",
					sshConfigAlias: "ec2-106",
				},
			},
		});
		await run.store.durableAppStorage.flush();
		run = await boot();
		const repeated = await run.add({ sshConfigAlias: "ec2-106" });
		expect(repeated).toMatchObject({
			ok: true,
			registration: { created: false, host: first?.registration?.host },
		});
		expect(run.store.useStore.getState().sshHosts).toHaveLength(1);
		expect(repeated?.registration?.host).not.toHaveProperty("secretId");
		expect(repeated?.registration?.host).not.toHaveProperty("password");
	});

	it("converges simultaneous CLI and GUI registration of an explicit key destination", async () => {
		const params = {
			host: "EXAMPLE.test",
			user: "ec2-user",
			keyPath: "~/.ssh/key.pem",
			name: "EC2",
		};
		const [cli, gui] = await Promise.all([
			run.add(params),
			run.lifecycle.createSshHostDurably({
				...params,
				host: "example.test",
				port: 22,
				auth: "key",
			}),
		]);
		expect(cli?.registration?.host.id).toBe(gui.host.id);
		expect(run.store.useStore.getState().sshHosts).toHaveLength(1);
		const saved = JSON.parse(
			localStorage.getItem(run.store.DURABLE_APP_STORE_NAME)!,
		);
		expect(saved.state.sshHosts).toHaveLength(1);
	});

	it("uses normal SSH authentication without a key and never scans config for direct fields", async () => {
		expect(
			await run.add({ host: "localhost", user: "user", port: 2200 }),
		).toMatchObject({
			ok: true,
			registration: {
				host: { host: "localhost", user: "user", port: 2200, auth: "auto" },
			},
		});
		expect(run.deps.scan).not.toHaveBeenCalled();
	});

	it.each([
		{},
		{ host: "example.test" },
		{ host: "example.test", user: "" },
		{ host: "example.test", user: "user", port: 0 },
		{ host: "example.test", user: "user", port: "22" },
		{ host: "ssh://example.test", user: "user" },
		{ host: "example.test", user: "user", password: "secret" },
		{ sshConfigAlias: "ec2-106", user: "override" },
	])("refuses invalid input before registration: %j", async (params) => {
		expect(await run.add(params)).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		expect(run.deps.create).not.toHaveBeenCalled();
		expect(run.deps.registerConfig).not.toHaveBeenCalled();
		expect(run.store.useStore.getState().sshHosts).toHaveLength(0);
	});

	it("reports absent aliases and registration failures without claiming persistence", async () => {
		expect(await run.add({ sshConfigAlias: "missing" })).toMatchObject({
			ok: false,
			error: { code: "ssh_config_host_not_found" },
		});
		run.deps.registerConfig.mockRejectedValueOnce(
			new Error("storage unavailable"),
		);
		expect(await run.add({ sshConfigAlias: "ec2-106" })).toEqual({
			ok: false,
			error: { code: "ssh_host_add_failed", message: "storage unavailable" },
		});
		expect(run.store.useStore.getState().sshHosts).toHaveLength(0);
	});

	it("lets only the claiming main window register a Host", async () => {
		run.deps.isMainWindow = () => false;
		expect(await run.add({ sshConfigAlias: "ec2-106" })).toBeNull();
		expect(run.deps.claim).not.toHaveBeenCalled();
		run.deps.isMainWindow = () => true;
		run.deps.claim.mockResolvedValue(false);
		expect(await run.add({ sshConfigAlias: "ec2-106" })).toBeNull();
		expect(run.deps.scan).not.toHaveBeenCalled();
		expect(run.deps.registerConfig).not.toHaveBeenCalled();
	});
});
