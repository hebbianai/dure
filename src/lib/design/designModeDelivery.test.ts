import { beforeEach, expect, it, vi } from "vitest";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { splitPromptAttachments } from "@/lib/agents/attachmentPrompt";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { deliverCaptureToAgent } from "@/lib/agents/captureDraftDelivery";

const mocks = vi.hoisted(() => ({
	local: vi.fn(),
	remote: vi.fn(),
	resolveRemote: vi.fn(),
	save: vi.fn(),
	upload: vi.fn(),
	read: vi.fn(),
	trust: vi.fn(),
}));
vi.mock("@/lib/ipc", async (original) => {
	const real = await original<typeof import("@/lib/ipc")>();
	return {
		...real,
		hmux: { ...real.hmux, commandInput: mocks.local },
		remoteHmuxCommandInput: mocks.remote,
		saveTempFiles: mocks.save,
		uploadSshFilesToTempDirectory: mocks.upload,
		readFile: mocks.read,
		prepareTrustedSshTarget: mocks.trust,
	};
});
vi.mock("@/lib/hmux/remote/remoteHmuxControllerResolution", () => ({
	resolveRemoteHmuxStandaloneController: mocks.resolveRemote,
}));
const fence = stopFenceFixture();
const agent = () =>
	managedAgentFixture({
		runtimeBinding: managedBindingFixture({ stopFence: fence }),
	});
const image = { fileName: "element.png", dataB64: "cG5nLWJ5dGVz" };
const attachments = [{ kind: "bytes" as const, file: image }];
function remoteAgent() {
	return managedAgentFixture({
		sessionKind: "ssh",
		runtimeBinding: {
			...managedBindingFixture({ stopFence: fence }),
			source: "ssh",
			hostId: "host-remote",
			commandBridgeNonce: "bridge-remote",
			createIdempotencyKey: "create:remote",
		},
	});
}
beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.trust.mockImplementation(async (hosts, hostId) => ({
		schemaVersion: 1,
		hostId,
		host: hosts[0].host,
		port: hosts[0].port,
		user: hosts[0].user,
		auth: hosts[0].auth,
		hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
	}));
	const receipt = {
		terminalEpoch: fence.terminalEpoch,
		text: { recordId: "1", state: "written_to_pty" },
	};
	mocks.local.mockResolvedValue(receipt);
	mocks.remote.mockResolvedValue(receipt);
	mocks.save.mockResolvedValue(["/tmp/local-private/element.png"]);
	mocks.upload.mockResolvedValue(["/tmp/remote-private/element.png"]);
	mocks.resolveRemote.mockResolvedValue({
		target: { hostId: "host-remote" },
		session: {
			sessionId: "session-1",
			workspaceId: "workspace-1",
			sessionClass: "managed",
			...fence,
		},
	});
	useStore.setState({
		agents: [agent()],
		projects: [],
		sshHosts: [
			{
				id: "host-remote",
				name: "Remote",
				host: "remote.invalid",
				port: 2222,
				user: "agent",
				auth: "auto",
			},
		],
	});
	useAgentAttention.setState({ armedCompletions: {} });
});
it("saves the captured bytes and references the returned local path in one unsubmitted input", async () => {
	await deliverCaptureToAgent("agent-1", "한글 요소 설명", attachments);
	expect(mocks.save).toHaveBeenCalledWith([image]);
	expect(mocks.upload).not.toHaveBeenCalled();
	expect(mocks.local).toHaveBeenCalledTimes(1);
	const body = mocks.local.mock.calls[0][0];
	expect(body).toMatchObject({
		sessionId: "session-1",
		workspaceId: "workspace-1",
		expectedFence: fence,
		submit: false,
	});
	expect(splitPromptAttachments(body.text)).toEqual({
		body: "한글 요소 설명",
		attachments: [
			{ path: "/tmp/local-private/element.png", fileName: "element.png" },
		],
	});
	expect(useAgentAttention.getState().armedCompletions).toEqual({});
});
it("uploads a standalone-window image to the receiving SSH host before typing its remote path", async () => {
	useStore.setState({ agents: [remoteAgent()] });
	mocks.read.mockResolvedValue({
		name: "window.png",
		kind: "image",
		mime: "image/png",
		content: image.dataB64,
		truncated: false,
	});
	await deliverCaptureToAgent("agent-1", "Element details", [
		{ kind: "local_file", path: "/tmp/local/window.png" },
	]);
	expect(mocks.read).toHaveBeenCalledWith("/tmp/local/window.png");
	expect(mocks.upload).toHaveBeenCalledWith(
		expect.objectContaining({
			host: "remote.invalid",
			port: 2222,
			user: "agent",
		}),
		[{ fileName: "window.png", dataB64: image.dataB64 }],
	);
	expect(mocks.save).not.toHaveBeenCalled();
	expect(mocks.local).not.toHaveBeenCalled();
	expect(mocks.remote).toHaveBeenCalledTimes(1);
	const body = mocks.remote.mock.calls[0][0];
	expect(body.submit).toBe(false);
	expect(body.text).toContain("/tmp/remote-private/element.png");
	expect(body.text).not.toContain("/tmp/local/window.png");
	expect(useAgentAttention.getState().armedCompletions).toEqual({});
});
it("routes details without attachments through the same exact remote input path", async () => {
	useStore.setState({ agents: [remoteAgent()] });
	await deliverCaptureToAgent("agent-1", "Details");
	expect(mocks.remote).toHaveBeenCalledWith(
		expect.objectContaining({ text: "Details", submit: false }),
	);
	expect(mocks.save).not.toHaveBeenCalled();
	expect(mocks.upload).not.toHaveBeenCalled();
});
it("does not deliver old paths when the recipient changes during file preparation", async () => {
	mocks.save.mockImplementationOnce(async () => {
		useStore.setState({
			agents: [
				managedAgentFixture({
					sessionId: "session-new",
					runtimeBinding: managedBindingFixture({
						sessionId: "session-new",
						stopFence: fence,
					}),
				}),
			],
		});
		return ["/tmp/old/element.png"];
	});
	await expect(
		deliverCaptureToAgent("agent-1", "Details", attachments),
	).rejects.toMatchObject({ code: "write_failed" });
	expect(mocks.local).not.toHaveBeenCalled();
	expect(mocks.save).toHaveBeenCalledTimes(1);
});
for (const result of [["relative.png"], ["/tmp/image.png\nrun command"], []])
	it(`rejects malformed prepared paths ${JSON.stringify(result)}`, async () => {
		mocks.save.mockResolvedValueOnce(result);
		await expect(
			deliverCaptureToAgent("agent-1", "Details", attachments),
		).rejects.toMatchObject({ code: "write_failed" });
		expect(mocks.local).not.toHaveBeenCalled();
	});
it("keeps transfer failure observable without typing or retrying", async () => {
	useStore.setState({ agents: [remoteAgent()] });
	mocks.upload.mockRejectedValueOnce(new Error("connection closed"));
	await expect(
		deliverCaptureToAgent("agent-1", "Details", attachments),
	).rejects.toMatchObject({ code: "write_failed" });
	expect(mocks.upload).toHaveBeenCalledTimes(1);
	expect(mocks.remote).not.toHaveBeenCalled();
});
it("rejects a missing or truncated saved image before writing recipient files", async () => {
	mocks.read.mockResolvedValue({
		name: "window.png",
		kind: "image",
		mime: "image/png",
		content: image.dataB64,
		truncated: true,
	});
	await expect(
		deliverCaptureToAgent("agent-1", "Details", [
			{ kind: "local_file", path: "/tmp/window.png" },
		]),
	).rejects.toMatchObject({ code: "write_failed" });
	expect(mocks.save).not.toHaveBeenCalled();
	expect(mocks.local).not.toHaveBeenCalled();
});
it("refuses a closed recipient before saving an image", async () => {
	useStore.setState({ agents: [] });
	await expect(
		deliverCaptureToAgent("agent-1", "Details", attachments),
	).rejects.toMatchObject({ code: "agent_missing" });
	expect(mocks.save).not.toHaveBeenCalled();
});

it.each(["local", "ssh"])(
	"does not deliver an image to a replacement %s generation with the same IDs",
	async (source) => {
		if (source === "ssh") useStore.setState({ agents: [remoteAgent()] });
		const transfer = source === "ssh" ? mocks.upload : mocks.save;
		transfer.mockImplementationOnce(async () => {
			useStore.setState((state) => ({
				agents: state.agents.map((candidate) => ({
					...candidate,
					runtimeBinding: {
						...candidate.runtimeBinding!,
						stopFence: { ...fence, terminalEpoch: "replacement" },
					},
				})),
			}));
			return ["/tmp/old-generation/element.png"];
		});
		await expect(
			deliverCaptureToAgent("agent-1", "Details", attachments),
		).rejects.toMatchObject({ code: "write_failed" });
		expect(transfer).toHaveBeenCalledTimes(1);
		expect(mocks.local).not.toHaveBeenCalled();
		expect(mocks.remote).not.toHaveBeenCalled();
	},
);
it("refuses an SSH host edit during local image read before uploading any bytes", async () => {
	useStore.setState({ agents: [remoteAgent()] });
	mocks.read.mockImplementationOnce(async () => {
		useStore.setState((state) => ({
			sshHosts: state.sshHosts.map((host) => ({
				...host,
				host: "replacement.invalid",
			})),
		}));
		return {
			name: "window.png",
			kind: "image",
			mime: "image/png",
			content: image.dataB64,
			truncated: false,
		};
	});
	await expect(
		deliverCaptureToAgent("agent-1", "Details", [
			{ kind: "local_file", path: "/tmp/window.png" },
		]),
	).rejects.toMatchObject({ code: "write_failed" });
	expect(mocks.upload).not.toHaveBeenCalled();
	expect(mocks.remote).not.toHaveBeenCalled();
});
it.each([
	{ host: "replacement.invalid" },
	{ port: 22 },
	{ user: "replacement" },
	{ registrationGeneration: "replacement" },
	{ sshConfigAlias: "replacement" },
	{ auth: "key" as const, keyPath: "/tmp/fixture-key" },
	{ secretId: "fixture-secret" },
])(
	"refuses recipient SSH configuration changes during upload: %j",
	async (patch) => {
		useStore.setState({ agents: [remoteAgent()] });
		mocks.upload.mockImplementationOnce(async () => {
			useStore.setState((state) => ({
				sshHosts: state.sshHosts.map((host) => ({ ...host, ...patch })),
			}));
			return ["/tmp/original-host/element.png"];
		});
		await expect(
			deliverCaptureToAgent("agent-1", "Details", attachments),
		).rejects.toMatchObject({ code: "write_failed" });
		expect(mocks.upload).toHaveBeenCalledTimes(1);
		expect(mocks.remote).not.toHaveBeenCalled();
		expect(mocks.resolveRemote).not.toHaveBeenCalled();
	},
);
it("allows a recipient host rename during upload without changing its transport", async () => {
	useStore.setState({ agents: [remoteAgent()] });
	mocks.upload.mockImplementationOnce(async () => {
		useStore.setState((state) => ({
			sshHosts: state.sshHosts.map((host) => ({
				...host,
				name: "New display name",
			})),
		}));
		return ["/tmp/same-host/element.png"];
	});
	await deliverCaptureToAgent("agent-1", "Details", attachments);
	expect(mocks.remote).toHaveBeenCalledTimes(1);
	expect(mocks.remote.mock.calls[0][0].text).toContain(
		"/tmp/same-host/element.png",
	);
});
it("does not upload when a closed recipient disappears during local image read", async () => {
	mocks.read.mockImplementationOnce(async () => {
		useStore.setState({ agents: [] });
		return {
			name: "window.png",
			kind: "image",
			mime: "image/png",
			content: image.dataB64,
			truncated: false,
		};
	});
	await expect(
		deliverCaptureToAgent("agent-1", "Details", [
			{ kind: "local_file", path: "/tmp/window.png" },
		]),
	).rejects.toMatchObject({ code: "write_failed" });
	expect(mocks.save).not.toHaveBeenCalled();
	expect(mocks.local).not.toHaveBeenCalled();
});

it.each(["local", "ssh"])(
	"keeps %s delivery valid while conversation identity advances",
	async (source) => {
		if (source === "ssh") useStore.setState({ agents: [remoteAgent()] });
		const transfer = source === "ssh" ? mocks.upload : mocks.save;
		transfer.mockImplementationOnce(async () => {
			useStore.setState((state) => ({
				agents: state.agents.map((candidate) => ({
					...candidate,
					name: "Renamed recipient",
					runtimeBinding: {
						...candidate.runtimeBinding!,
						conversationIdentity: {
							schemaVersion: 1 as const,
							sessionId: "session-1",
							workspaceId: "workspace-1",
							...fence,
							revision: "2",
							observedThroughOutputSeq: "3",
							providerId: "codex" as const,
							conversationId: "conversation-1",
							source: "provider_event" as const,
						},
					},
				})),
			}));
			return ["/tmp/same-session/element.png"];
		});
		await deliverCaptureToAgent("agent-1", "Details", attachments);
		expect(source === "ssh" ? mocks.remote : mocks.local).toHaveBeenCalledTimes(
			1,
		);
		expect(
			(source === "ssh" ? mocks.remote : mocks.local).mock.calls[0][0].text,
		).toContain("/tmp/same-session/element.png");
	},
);
