import { describe, expect, it, vi } from "vitest";
import {
	conversationActivityAt,
	conversationPrompt,
	conversationTitle,
	publishConversationMetadata,
} from "@/lib/agents/chat/conversationPresentationState";
import {
	installProviderConversationMetadataRuntime,
	REMOTE_REFRESH_INTERVAL_MS,
} from "@/lib/agents/providerConversationMetadataRuntime";
import type { ProviderConversationMetadata } from "@/lib/ipc/conversations";
import { managedAgentFixture } from "@/test/agentFixtures";
import type { AgentRuntimeBindingV1, SshHostConfig } from "@/types";

const remoteHost: SshHostConfig = {
	id: "host-1",
	name: "build box",
	host: "build.example",
	port: 22,
	user: "dev",
	auth: "auto",
};

function sshBindingFixture(
	patch: Partial<Extract<AgentRuntimeBindingV1, { source: "ssh" }>> = {},
): AgentRuntimeBindingV1 {
	return {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		source: "ssh",
		hostId: remoteHost.id,
		sessionId: "remote-session-1",
		workspaceId: "remote-workspace-1",
		createIdempotencyKey: "create-1",
		commandBridgeNonce: "nonce-1",
		...patch,
	};
}

describe("providerConversationMetadataRuntime", () => {
	it("releases the default browser timer without changing its receiver", async () => {
		const timer = 42 as never;
		const release = vi.fn(function (this: unknown, handle: unknown) {
			if (this !== undefined && this !== globalThis) {
				throw new TypeError("Window.clearInterval requires a Window receiver");
			}
			expect(handle).toBe(timer);
		});
		vi.stubGlobal(
			"setInterval",
			vi.fn(() => timer),
		);
		vi.stubGlobal("clearInterval", release);
		vi.resetModules();
		try {
			const { installProviderConversationMetadataRuntime: install } =
				await import("@/lib/agents/providerConversationMetadataRuntime");
			const stop = install();
			expect(stop).not.toThrow();
			stop();
			expect(release).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
			vi.resetModules();
		}
	});

	it("projects an exact credential-scoped native title into the shared title state", async () => {
		const agent = managedAgentFixture({
			id: "agent-native-title-runtime",
			provider: "codex",
			conversationId: "thread-1",
			credentialId: "credential-1",
		});
		const load = vi.fn().mockResolvedValue([
			{
				title: "clean code",
				activityAt: "2026-09-05T13:39:18.095Z",
			},
		]);
		const clearInterval = vi.fn();
		const stop = installProviderConversationMetadataRuntime({
			readState: () => ({
				agents: [agent],
				accounts: [
					{
						id: "credential-1",
						provider: "codex",
						name: "Work",
						dir: "/profiles/codex-work",
					},
				],
				sshHosts: [],
			}),
			subscribe: () => () => undefined,
			load,
			publish: publishConversationMetadata,
			setInterval: vi.fn(() => 42 as never),
			clearInterval,
			now: () => 0,
		});

		await vi.waitFor(() =>
			expect(conversationTitle(agent.id)).toBe("clean code"),
		);
		expect(load).toHaveBeenCalledWith(
			[
				{
					provider: "codex",
					conversationId: "thread-1",
					cwd: agent.worktreePath,
					credentialProfile: {
						referenceId: "credential-1",
						directory: "/profiles/codex-work",
					},
				},
			],
			undefined,
		);
		expect(conversationActivityAt(agent.id, "thread-1")).toBe(
			Date.parse("2026-09-05T13:39:18.095Z"),
		);

		stop();
		expect(clearInterval).toHaveBeenCalledWith(42);
	});

	it("ignores a title returned after the Agent moved to another conversation", async () => {
		let resolveLookup: (
			metadata: Array<ProviderConversationMetadata | null>,
		) => void = () => undefined;
		const load = vi.fn(
			() =>
				new Promise<Array<ProviderConversationMetadata | null>>((resolve) => {
					resolveLookup = resolve;
				}),
		);
		const agent = managedAgentFixture({
			id: "agent-stale-native-title-runtime",
			conversationId: "thread-old",
		});
		let agents = [agent];
		const publish = vi.fn();
		const stop = installProviderConversationMetadataRuntime({
			readState: () => ({ agents, accounts: [], sshHosts: [] }),
			subscribe: () => () => undefined,
			load,
			publish,
			setInterval: vi.fn(() => 42 as never),
			clearInterval: vi.fn(),
			now: () => 0,
		});
		await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
		agents = [{ ...agent, conversationId: "thread-new" }];
		resolveLookup([
			{ title: "stale title", activityAt: "2026-09-05T13:39:18Z" },
		]);
		await Promise.resolve();
		await Promise.resolve();

		expect(publish).not.toHaveBeenCalled();
		stop();
	});

	it("reads a remote native session through its registered host and projects prompt and activity", async () => {
		const agent = managedAgentFixture({
			id: "agent-remote-metadata-runtime",
			provider: "claude",
			conversationId: "remote-thread-1",
			worktreePath: "/srv/repo/.worktrees/agent-1",
			credentialId: "credential-remote",
			runtimeBinding: sshBindingFixture({
				credentialId: "credential-remote",
				credentialProfileDirectory: ".dure/accounts/claude-work",
			}),
		});
		const load = vi.fn().mockResolvedValue([
			{
				title: null,
				activityAt: "2026-09-12T10:00:00Z",
				recentPrompts: ["첫 프롬프트", "계속해"],
			},
		]);
		const stop = installProviderConversationMetadataRuntime({
			readState: () => ({
				agents: [agent],
				accounts: [],
				sshHosts: [remoteHost],
			}),
			subscribe: () => () => undefined,
			load,
			publish: publishConversationMetadata,
			setInterval: vi.fn(() => 42 as never),
			clearInterval: vi.fn(),
			now: () => 0,
		});

		await vi.waitFor(() =>
			expect(conversationPrompt(agent.id, "remote-thread-1")).toBe("계속해"),
		);
		expect(load).toHaveBeenCalledWith(
			[
				{
					provider: "claude",
					conversationId: "remote-thread-1",
					cwd: "/srv/repo/.worktrees/agent-1",
					credentialProfile: {
						referenceId: "credential-remote",
						directory: ".dure/accounts/claude-work",
					},
				},
			],
			remoteHost,
		);
		expect(conversationActivityAt(agent.id, "remote-thread-1")).toBe(
			Date.parse("2026-09-12T10:00:00Z"),
		);
		stop();
	});

	it("re-reads one host on the remote cadence and immediately when its targets change", async () => {
		const agent = managedAgentFixture({
			id: "agent-remote-cadence-runtime",
			provider: "claude",
			conversationId: "remote-thread-1",
			runtimeBinding: sshBindingFixture(),
		});
		let agents = [agent];
		let now = 1_000;
		let listener: () => void = () => undefined;
		const load = vi.fn().mockResolvedValue([null]);
		const stop = installProviderConversationMetadataRuntime({
			readState: () => ({ agents, accounts: [], sshHosts: [remoteHost] }),
			subscribe: (next) => {
				listener = next;
				return () => undefined;
			},
			load,
			publish: vi.fn(),
			setInterval: vi.fn(() => 42 as never),
			clearInterval: vi.fn(),
			now: () => now,
		});
		await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
		// The cadence counts from the completed read, so let it settle first.
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
		await settle();

		now += REMOTE_REFRESH_INTERVAL_MS - 1;
		listener();
		await settle();
		expect(load).toHaveBeenCalledOnce();

		now += 1;
		listener();
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
		await settle();

		agents = [{ ...agent, conversationId: "remote-thread-2" }];
		listener();
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
		expect(load).toHaveBeenLastCalledWith(
			[expect.objectContaining({ conversationId: "remote-thread-2" })],
			remoteHost,
		);
		stop();
	});

	it("keeps reading local files while a remote host stalls, one read per host", async () => {
		const local = managedAgentFixture({
			id: "agent-local-beside-stalled-host",
			conversationId: "thread-local",
		});
		const remote = managedAgentFixture({
			id: "agent-on-stalled-host",
			provider: "claude",
			conversationId: "thread-remote",
			runtimeBinding: sshBindingFixture(),
		});
		let listener: () => void = () => undefined;
		const load = vi.fn((_targets: unknown, host: SshHostConfig | undefined) =>
			host
				? new Promise<Array<ProviderConversationMetadata | null>>(
						() => undefined,
					)
				: Promise.resolve([null]),
		);
		const stop = installProviderConversationMetadataRuntime({
			readState: () => ({
				agents: [remote, local],
				accounts: [],
				sshHosts: [remoteHost],
			}),
			subscribe: (next) => {
				listener = next;
				return () => undefined;
			},
			load,
			publish: vi.fn(),
			setInterval: vi.fn(() => 42 as never),
			clearInterval: vi.fn(),
			now: () => 0,
		});
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
		listener();
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
		expect(load.mock.calls.map(([, host]) => host?.id)).toEqual([
			remoteHost.id,
			undefined,
			undefined,
		]);
		stop();
	});

	it("echoes the remote change token and keeps the standing observation when unchanged", async () => {
		const agent = managedAgentFixture({
			id: "agent-remote-unchanged-runtime",
			provider: "claude",
			conversationId: "remote-thread-1",
			runtimeBinding: sshBindingFixture(),
		});
		let now = 0;
		let listener: () => void = () => undefined;
		const load = vi
			.fn()
			.mockResolvedValueOnce([
				{
					title: null,
					activityAt: "2026-09-12T10:00:00Z",
					recentPrompts: ["계속해"],
					observed: "120:1757671200000000000",
				},
			])
			.mockResolvedValue([{ unchanged: true }]);
		const publish = vi.fn();
		const stop = installProviderConversationMetadataRuntime({
			readState: () => ({
				agents: [agent],
				accounts: [],
				sshHosts: [remoteHost],
			}),
			subscribe: (next) => {
				listener = next;
				return () => undefined;
			},
			load,
			publish,
			setInterval: vi.fn(() => 42 as never),
			clearInterval: vi.fn(),
			now: () => now,
		});
		await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
		expect(load.mock.calls[0][0][0]).not.toHaveProperty("observed");

		now += REMOTE_REFRESH_INTERVAL_MS;
		listener();
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
		expect(load.mock.calls[1][0][0]).toMatchObject({
			conversationId: "remote-thread-1",
			observed: "120:1757671200000000000",
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(publish).toHaveBeenCalledOnce();
		stop();
	});

	it("never reads a remote session whose host is not registered", async () => {
		const local = managedAgentFixture({
			id: "agent-local-beside-unregistered",
			conversationId: "thread-local",
		});
		const orphan = managedAgentFixture({
			id: "agent-unregistered-host",
			conversationId: "thread-remote",
			runtimeBinding: sshBindingFixture({ hostId: "host-missing" }),
		});
		const load = vi.fn().mockResolvedValue([null]);
		const stop = installProviderConversationMetadataRuntime({
			readState: () => ({
				agents: [local, orphan],
				accounts: [],
				sshHosts: [remoteHost],
			}),
			subscribe: () => () => undefined,
			load,
			publish: vi.fn(),
			setInterval: vi.fn(() => 42 as never),
			clearInterval: vi.fn(),
			now: () => 0,
		});
		await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
		expect(load).toHaveBeenCalledWith(
			[expect.objectContaining({ conversationId: "thread-local" })],
			undefined,
		);
		stop();
	});
});
