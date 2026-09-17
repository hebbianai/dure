import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	copyClaudeSession: vi.fn(),
	copyClaudeSessionCommand: vi.fn(),
	createWorktree: vi.fn(),
	listConversations: vi.fn(),
	requireProjectProvider: vi.fn(),
	preflightRemoteAccountLaunch: vi.fn(),
	sshExecOnce: vi.fn(),
	worktreeCommand: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
	copyClaudeSession: mocks.copyClaudeSession,
	copyClaudeSessionCommand: mocks.copyClaudeSessionCommand,
	createWorktree: mocks.createWorktree,
	hostToOpts: vi.fn(),
	listConversations: mocks.listConversations,
	sshExecOnce: mocks.sshExecOnce,
	sshListConversations: vi.fn(),
	worktreeCommand: mocks.worktreeCommand,
}));

vi.mock("@/lib/agents/providerPreflight", () => ({
	requireProjectProvider: mocks.requireProjectProvider,
}));

vi.mock("@/lib/agents/remoteAccountOverlay", () => ({
	preflightRemoteAccountLaunch: mocks.preflightRemoteAccountLaunch,
}));

import { forkAgent } from "@/lib/agents/fork";
import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { AccountProfile, Agent } from "@/types";

const crispy: AccountProfile = {
	id: "acc-crispy",
	provider: "codex",
	name: "crispy",
	dir: "/Users/test/.dure/accounts/codex-crispy",
};

const source: Agent = agentFixture({
	id: "agent-source",
	name: "codex-source",
	worktreePath: "/repo/.worktrees/source",
	branch: "agent/source",
	sessionId: "agent-source",
	runtimeBinding: managedBindingFixture({
		sessionId: "agent-source",
		workspaceId: "project-1",
		createIdempotencyKey: undefined,
		credentialId: crispy.id,
	}),
	accountId: crispy.id,
	credentialId: crispy.id,
	conversationId: "conversation-source",
});

beforeEach(() => {
	mocks.copyClaudeSession.mockReset().mockResolvedValue(undefined);
	mocks.copyClaudeSessionCommand
		.mockReset()
		.mockResolvedValue("copy claude session");
	mocks.createWorktree.mockReset().mockResolvedValue({
		path: "/repo/.worktrees/codex-source-fork",
		branch: "agent/codex-source-fork",
	});
	mocks.listConversations.mockReset().mockResolvedValue([
		{
			id: "conversation-exact",
			provider: "codex",
			title: "exact",
			updatedAt: 1,
		},
	]);
	mocks.requireProjectProvider.mockReset().mockResolvedValue(undefined);
	mocks.preflightRemoteAccountLaunch.mockReset().mockResolvedValue({
		version: "codex-cli 1.0.0",
		overlay: {
			remoteDirectory: ".dure/accounts/codex-crispy",
			credentialPresent: true,
		},
	});
	mocks.sshExecOnce.mockReset().mockResolvedValue({
		code: 0,
		stdout: "",
		stderr: "",
	});
	mocks.worktreeCommand
		.mockReset()
		.mockResolvedValue([
			"git worktree add ...",
			"/srv/repo/.worktrees/codex-source-fork",
			"agent/codex-source-fork",
		]);
	useStore.setState({
		projects: [
			{
				id: "project-1",
				name: "repo",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [source],
		accounts: [crispy],
		activeAccounts: { codex: crispy.id },
		skipPermissions: {},
	});
});

describe("managed agent fork", () => {
	it("does not publish or acknowledge a fork before the shared durable writer commits", async () => {
		await durableAppStorage.flush();
		let release = () => {};
		let entered = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const observed = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const request = navigator.locks.request.bind(navigator.locks);
		const lock = vi
			.spyOn(navigator.locks, "request")
			.mockImplementation((...args: Parameters<typeof request>) => {
				entered();
				return held.then(() => request(...args));
			});
		let acknowledged = false;
		const pending = forkAgent(source.id, "codex").then((value) => {
			acknowledged = true;
			return value;
		});
		try {
			await observed;
			expect(acknowledged).toBe(false);
			expect(useStore.getState().agents.map((agent) => agent.id)).toEqual([
				source.id,
			]);
			expect(
				JSON.parse(localStorage.getItem(DURABLE_APP_STORE_NAME)!).state.agents,
			).toHaveLength(1);
		} finally {
			release();
			lock.mockRestore();
			await pending;
		}
		const fork = await pending;
		expect(
			await durableAppStorage.read(DURABLE_APP_STORE_NAME, (current) =>
				current?.state.agents.map((agent) => agent.id),
			),
		).toEqual([source.id, fork.id]);
	});

	it("forks Codex history while leaving the generated child identity unseeded", async () => {
		const fork = await forkAgent(source.id, "codex");

		expect(fork).toMatchObject({
			provider: "codex",
			credentialId: crispy.id,
			accountId: crispy.id,
			started: true,
			pendingCmd:
				"codex -c check_for_update_on_startup=false -C . fork conversation-source",
			runtimeBinding: {
				runtime: "hmux_managed_v1",
				credentialId: crispy.id,
			},
		});
		expect(mocks.listConversations).not.toHaveBeenCalled();
		expect(fork.conversationId).toBeUndefined();
	});

	it("forks the backend-projected Structured conversation without rescanning sibling history", async () => {
		useStore.setState({
			agents: [
				{
					...source,
					runtimeBinding: undefined,
					conversationId: "conversation-structured-source",
					interactionProfile: {
						schemaVersion: 1,
						kind: "structured_protocol",
						backendProfileId: "local",
						interactionSessionId: "interaction-source",
					},
				},
			],
		});
		mocks.listConversations.mockResolvedValueOnce([
			{
				id: "conversation-newer-sibling",
				provider: "codex",
				title: "newer sibling",
				updatedAt: 2,
			},
		]);

		const fork = await forkAgent(source.id, "codex");

		expect(mocks.listConversations).not.toHaveBeenCalled();
		expect(fork.pendingCmd).toBe(
			"codex -c check_for_update_on_startup=false -C . fork conversation-structured-source",
		);
	});

	it("does not inherit stale credential fields over a committed provider default", async () => {
		useStore.setState({
			agents: [
				{
					...source,
					executionProfile: { kind: "provider_default" },
					runtimeBinding: managedBindingFixture({ credentialId: crispy.id }),
					accountId: crispy.id,
					credentialId: crispy.id,
				},
			],
		});

		const fork = await forkAgent(source.id, "codex");

		expect(fork.accountId).toBeNull();
		expect(fork.credentialId).toBeUndefined();
		expect(
			fork.runtimeBinding?.runtime === "hmux_managed_v1"
				? fork.runtimeBinding.credentialId
				: undefined,
		).toBeUndefined();
	});

	it("inherits the committed credential instead of a stale account projection", async () => {
		const committed: AccountProfile = {
			id: "acc-committed",
			provider: "codex",
			name: "committed",
			dir: "/Users/test/.dure/accounts/codex-committed",
		};
		useStore.setState({
			agents: [
				{
					...source,
					executionProfile: {
						kind: "credential_reference",
						reference_id: committed.id,
						credential_generation: "generation-committed",
					},
					runtimeBinding: managedBindingFixture({ credentialId: crispy.id }),
					accountId: crispy.id,
					credentialId: crispy.id,
				},
			],
			accounts: [crispy, committed],
		});

		const fork = await forkAgent(source.id, "codex");

		expect(fork.accountId).toBe(committed.id);
		expect(fork.credentialId).toBe(committed.id);
		expect(
			fork.runtimeBinding?.runtime === "hmux_managed_v1"
				? fork.runtimeBinding.credentialId
				: undefined,
		).toBe(committed.id);
	});

	it("reads a pre-profile source history from its persisted credential root", async () => {
		useStore.setState({
			agents: [
				{
					...source,
					runtimeBinding: undefined,
					conversationId: undefined,
					executionProfile: undefined,
				},
			],
		});

		await forkAgent(source.id, "codex");

		expect(mocks.listConversations).toHaveBeenCalledWith(
			source.worktreePath,
			"codex",
			{ referenceId: crispy.id, directory: crispy.dir },
		);
	});

	it("forks Claude history without persisting the source identity as the child", async () => {
		useStore.setState({
			agents: [
				{
					...source,
					provider: "claude",
					accountId: undefined,
					credentialId: undefined,
					runtimeBinding: managedBindingFixture({ credentialId: undefined }),
				},
			],
			accounts: [],
			activeAccounts: {},
		});

		const fork = await forkAgent(source.id, "claude");

		expect(mocks.copyClaudeSession).toHaveBeenCalledWith(
			source.worktreePath,
			"/repo/.worktrees/codex-source-fork",
			"conversation-source",
		);
		expect(fork).toMatchObject({
			provider: "claude",
			started: true,
			pendingCmd: "claude --resume conversation-source --fork-session",
		});
		expect(fork.conversationId).toBeUndefined();
	});

	it("refuses an unresolved managed source before creating a worktree", async () => {
		useStore.setState({
			agents: [
				{
					...source,
					conversationId: undefined,
					conversationIdentity: {
						state: "pending",
						code: "conversation_identity_required",
						detail: "provider rollout has not been observed",
					},
				},
			],
		});

		await expect(forkAgent(source.id, "codex")).rejects.toThrow(
			"fork_source_conversation_identity_required",
		);
		expect(mocks.createWorktree).not.toHaveBeenCalled();
		expect(mocks.listConversations).not.toHaveBeenCalled();
	});

	it.each(["gemini", "opencode"] as const)(
		"starts %s fresh because exact resume is not a reviewed cross-worktree fork",
		async (provider) => {
			useStore.setState({
				agents: [
					{
						...source,
						provider,
						accountId: undefined,
						credentialId: undefined,
						runtimeBinding: managedBindingFixture({ credentialId: undefined }),
					},
				],
				accounts: [],
				activeAccounts: {},
			});

			const fork = await forkAgent(source.id, provider);

			expect(mocks.listConversations).not.toHaveBeenCalled();
			expect(fork).toMatchObject({
				provider,
				started: false,
			});
			expect(fork.pendingCmd).toBeUndefined();
			expect(fork.conversationId).toBeUndefined();
		},
	);

	it.each([
		[
			"pi",
			(id: string): string =>
				`pi --fork conversation-source --session-id ${id}`,
		],
		[
			"grok",
			(id: string): string =>
				`grok --resume conversation-source --fork-session --session-id ${id}`,
		],
	] as const)(
		"uses %s's native fork without copying Claude records",
		async (provider, pendingCmd) => {
			useStore.setState({
				agents: [
					{
						...source,
						provider,
						accountId: undefined,
						credentialId: undefined,
						runtimeBinding: managedBindingFixture({ credentialId: undefined }),
					},
				],
				accounts: [],
				activeAccounts: {},
			});

			const fork = await forkAgent(source.id, provider);

			expect(fork.conversationId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
			);
			expect(fork).toMatchObject({
				provider,
				started: true,
				pendingCmd: pendingCmd(fork.conversationId!),
			});
			expect(mocks.copyClaudeSession).not.toHaveBeenCalled();
			expect(mocks.copyClaudeSessionCommand).not.toHaveBeenCalled();
		},
	);

	it("fails a remote overlay preflight before creating a remote worktree", async () => {
		useStore.setState({
			projects: [
				{
					id: "project-1",
					name: "repo",
					path: "/srv/repo",
					kind: "ssh",
					sshHostId: "host-1",
					isRepo: true,
				},
			],
			sshHosts: [
				{
					id: "host-1",
					name: "remote",
					host: "example.test",
					port: 22,
					user: "tester",
					auth: "auto",
				},
			],
			agents: [
				{
					...source,
					worktreePath: "/srv/repo/.worktrees/source",
					sessionKind: "ssh",
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "legacy_ssh_session_v1",
						source: "ssh",
						hostId: "host-1",
						sessionId: source.sessionId,
					} as unknown as Agent["runtimeBinding"],
				},
			],
		});

		mocks.preflightRemoteAccountLaunch.mockRejectedValue(
			new Error("remote credential unavailable"),
		);

		await expect(forkAgent(source.id, "codex")).rejects.toThrow(
			"remote credential unavailable",
		);
		expect(mocks.worktreeCommand).not.toHaveBeenCalled();
	});

	it("forks an SSH-project agent onto the remote managed runtime", async () => {
		useStore.setState({
			projects: [
				{
					id: "project-1",
					name: "repo",
					path: "/srv/repo",
					kind: "ssh",
					sshHostId: "host-1",
					isRepo: true,
				},
			],
			sshHosts: [
				{
					id: "host-1",
					name: "remote",
					host: "example.test",
					port: 22,
					user: "tester",
					auth: "auto",
				},
			],
			agents: [
				{
					...source,
					worktreePath: "/srv/repo/.worktrees/source",
					sessionKind: "ssh",
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "hmux_managed_v1",
						source: "ssh",
						hostId: "host-1",
						sessionId: source.sessionId,
						workspaceId: "project-1",
						createIdempotencyKey: "create-source",
						commandBridgeNonce: "bridge-source",
					},
				},
			],
		});

		const fork = await forkAgent(source.id, "codex");

		expect(fork.runtimeBinding).toMatchObject({
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "host-1",
			workspaceId: "project-1",
			createIdempotencyKey: fork.id,
			commandBridgeNonce: `bridge_${fork.id}`,
		});
	});
});
