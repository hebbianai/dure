import { beforeEach, expect, it, vi } from "vitest";
import { useStore } from "@/store";
import { saveSessionFiles } from "./sessionFileTransfer";

const mocks = vi.hoisted(() => ({
	trust: vi.fn(),
	upload: vi.fn(),
	save: vi.fn(),
	route: vi.fn(),
}));
vi.mock("@/lib/ipc", async (original) => {
	const real = await original<typeof import("@/lib/ipc")>();
	return {
		...real,
		prepareTrustedSshTarget: mocks.trust,
		uploadSshFilesToTempDirectory: mocks.upload,
		saveTempFiles: mocks.save,
		routeSessionFiles: mocks.route,
	};
});
const host = {
	id: "remote",
	name: "Remote",
	host: "remote.test",
	port: 2222,
	user: "agent",
	auth: "key" as const,
	keyPath: "/tmp/fixture-key",
};
const target = {
	schemaVersion: 1,
	hostId: host.id,
	host: host.host,
	port: host.port,
	user: host.user,
	auth: host.auth,
	keyPath: host.keyPath,
	hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
};
const files = [{ fileName: "element.png", dataB64: "cG5n" }];
beforeEach(() => {
	mocks.trust.mockReset().mockResolvedValue(target);
	mocks.upload.mockReset().mockResolvedValue(["/tmp/remote/element.png"]);
	mocks.save.mockReset().mockResolvedValue(["/tmp/local/element.png"]);
	mocks.route.mockReset().mockResolvedValue(["/tmp/destination/element.png"]);
	useStore.setState({ sshHosts: [{ ...host }] });
});

it.each([undefined, "remote"])(
	"resolves files on the receiving session after staging on %s",
	async (hostId) => {
		const session = {
			sessionId: "shell",
			workspaceId: "workspace",
			terminalEpoch: "epoch",
		};
		await expect(saveSessionFiles(hostId, files, session)).resolves.toEqual([
			"/tmp/destination/element.png",
		]);
		expect(mocks.route).toHaveBeenCalledWith({
			...session,
			paths: [hostId ? "/tmp/remote/element.png" : "/tmp/local/element.png"],
			...(hostId
				? {
						opts: {
							host: host.host,
							port: host.port,
							user: host.user,
							auth: host.auth,
							keyPath: host.keyPath,
							hostKeyFingerprints: target.hostKeyFingerprints,
						},
					}
				: {}),
		});
	},
);

it("does not return staged paths when the SSH route cannot be established", async () => {
	mocks.route.mockRejectedValue(
		new Error("session_file_ssh_config_unavailable"),
	);
	await expect(
		saveSessionFiles(undefined, files, {
			sessionId: "shell",
			workspaceId: "workspace",
			terminalEpoch: "epoch",
		}),
	).rejects.toThrow("session_file_ssh_config_unavailable");
});
it("pins uploaded bytes to the existing trusted SSH authority", async () => {
	await expect(saveSessionFiles(host.id, files)).resolves.toEqual([
		"/tmp/remote/element.png",
	]);
	expect(mocks.trust).toHaveBeenCalledWith([host], host.id);
	expect(mocks.upload).toHaveBeenCalledWith(
		expect.objectContaining({
			hostKeyFingerprints: target.hostKeyFingerprints,
			host: host.host,
			keyPath: host.keyPath,
		}),
		files,
	);
});
it("refuses an unenrolled host before uploading bytes", async () => {
	mocks.trust.mockRejectedValueOnce(new Error("remote_hmux_host_untrusted"));
	await expect(saveSessionFiles(host.id, files)).rejects.toThrow(
		"remote_hmux_host_untrusted",
	);
	expect(mocks.upload).not.toHaveBeenCalled();
});
it("refuses a host edit while its trust is being resolved", async () => {
	mocks.trust.mockImplementationOnce(async () => {
		useStore.setState({ sshHosts: [{ ...host, host: "replacement.test" }] });
		return target;
	});
	await expect(saveSessionFiles(host.id, files)).rejects.toThrow(
		"session_file_host_changed",
	);
	expect(mocks.upload).not.toHaveBeenCalled();
});
it("keeps a host rename valid during trust resolution", async () => {
	mocks.trust.mockImplementationOnce(async () => {
		useStore.setState({ sshHosts: [{ ...host, name: "Renamed" }] });
		return target;
	});
	await saveSessionFiles(host.id, files);
	expect(mocks.upload).toHaveBeenCalledTimes(1);
});
it("saves local files without resolving SSH trust", async () => {
	await expect(saveSessionFiles(undefined, files)).resolves.toEqual([
		"/tmp/local/element.png",
	]);
	expect(mocks.trust).not.toHaveBeenCalled();
	expect(mocks.upload).not.toHaveBeenCalled();
});

it("withholds paths after the SSH host changes during routing", async () => {
	mocks.route.mockImplementationOnce(async () => {
		useStore.setState({ sshHosts: [{ ...host, host: "replacement.test" }] });
		return ["/tmp/destination/image.png"];
	});
	await expect(
		saveSessionFiles(host.id, files, {
			sessionId: "shell",
			workspaceId: "workspace",
			terminalEpoch: "epoch",
		}),
	).rejects.toThrow("session_file_host_changed");
});
