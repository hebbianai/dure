import { describe, expect, it, vi } from "vitest";
import { publishHmuxControlPlaneCensus } from "@/lib/hmux/identity/hmuxControlPlaneCensusFeed";
import { buildRegistry, startRegistrySync } from "@/lib/persistence/registry";
import { useStore } from "@/store";
import {
	agentFixture,
	hmuxSessionSummaryFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	agentDisplayName: vi.fn(),
	invoke: vi.fn((_command: string, _params?: Record<string, unknown>) =>
		Promise.resolve(undefined),
	),
	readPublishedAgentRegistry: vi.fn(() =>
		Promise.resolve(
			JSON.stringify({
				version: 3,
				updatedAt: 1,
				sshHosts: [],
				localSessionBin: "",
				agents: [
					{
						id: "prior-agent",
						name: "prior-agent",
						displayName: "prior-agent",
						project: "repo",
						sessionId: "managed-orphan",
						remoteTmux: "managed-orphan",
						kind: "pty",
						provider: "codex",
						worktree: "/repo/prior",
						branch: "agent/prior",
						comment: "",
						commentUpdatedAt: null,
						ssh: null,
						runtimeBinding: {
							runtime: "hmux_managed_v1",
							source: "local",
							sessionId: "managed-orphan",
							workspaceId: "workspace-1",
						},
						credentialId: null,
						conversationId: null,
					},
				],
				projects: [],
			}),
		),
	),
	reconcileCleanup: vi.fn(() => []),
	recoverRemoteCleanup: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/agents/agentDisplayName", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/agents/agentDisplayName")>();
	mocks.agentDisplayName.mockImplementation(actual.agentDisplayName);
	return { ...actual, agentDisplayName: mocks.agentDisplayName };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/ipc/persistence", () => ({
	readPublishedAgentRegistry: mocks.readPublishedAgentRegistry,
}));
vi.mock(
	"@/lib/sessions/cleanup/exitedManagedAgentCleanupCompensationRuntime",
	() => ({
		reconcileExitedManagedAgentCleanupCompensations: mocks.reconcileCleanup,
		recoverRemoteManagedAgentCleanupCompensations: mocks.recoverRemoteCleanup,
	}),
);

describe("agent registry runtime binding", () => {
	it("publishes the structured interaction identity without exposing composed draft data", () => {
		const profile = { schemaVersion: 1 as const, kind: "structured_protocol" as const, backendProfileId: "local", interactionSessionId: "interaction-registry" };
		useStore.setState({ agents: [agentFixture({ id: "chat-registry", runtimeBinding: undefined, interactionProfile: profile })],
			chatDrafts: { "chat-registry": { scope: { text: "private draft", attachments: [{ fileName: "secret.png", dataB64: "private-bytes" }] } } },
		});
		const registry = buildRegistry();
		expect(registry.agents[0].interactionProfile).toEqual(profile);
		expect(JSON.stringify(registry)).not.toContain("private draft");
		expect(JSON.stringify(registry)).not.toContain("private-bytes");
		expect(JSON.stringify(registry)).not.toContain("chatDrafts");
	});
	it("persists only non-secret managed identity and never initializes legacy PTY", () => {
		const agent: Agent = agentFixture({
			id: "agent-managed",
			name: "managed",
			displayName: "Release QA",
			worktreePath: "/repo/worktree",
			branch: "agent/managed",
			sessionId: "agent-managed",
			credentialId: "credential-reference",
			conversationId: "conversation-1",
			pendingCmd: "codex --token super-secret",
			runtimeBinding: {
				...managedBindingFixture({
					sessionId: "agent-managed",
					workspaceId: "project-1",
					createIdempotencyKey: "agent-managed",
					credentialId: "credential-reference",
					credentialGeneration: 7,
				}),
				authToken: "super-secret",
			} as Agent["runtimeBinding"],
		});
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
			agents: [agent],
		});

		const registry = buildRegistry();
		const encoded = JSON.stringify(registry);

		// The legacy daemon binary path field is gone with the runtime (2026-08-16).
		expect("localSessionBin" in registry).toBe(false);
		expect(registry.clientPresentation).toMatchObject({
			schemaVersion: 3,
			complete: true,
			spaces: expect.any(Array),
		});
		expect(registry.agents[0]).toMatchObject({
			id: "agent-managed",
			name: "managed",
			displayName: "Release QA",
			sessionId: "agent-managed",
			credentialId: "credential-reference",
			conversationId: "conversation-1",
			runtimeBinding: {
				runtime: "hmux_managed_v1",
				createIdempotencyKey: "agent-managed",
				credentialId: "credential-reference",
				credentialGeneration: 7,
			},
		});
		expect(encoded).not.toContain("authToken");
		expect(encoded).not.toContain("super-secret");
		expect(encoded).not.toContain("pendingCmd");
	});

	it("exports every configured SSH host for pairing, without any secret", () => {
		useStore.setState({
			projects: [],
			agents: [],
			sshHosts: [
				{
					id: "host-1",
					name: "build box",
					sshConfigAlias: "build-via-bastion",
					host: "10.0.0.4",
					port: 2222,
					user: "kattpish",
					auth: "key",
					keyPath: "~/.ssh/id_ed25519",
					secretId: "keychain-account",
					password: "legacy-plaintext",
				},
				{
					id: "host-2",
					name: "tailscale box",
					host: "box.tailnet.ts.net",
					port: 22,
					user: "kattpish",
					auth: "auto",
				},
			],
		});

		const registry = buildRegistry();
		const encoded = JSON.stringify(registry);

		// `hmux pair` refuses to run against an export with no sshHosts array,
		// so a dropped host is a server the phone silently never reaches.
		expect(registry.sshHosts).toEqual([
			{
				id: "host-1",
				name: "build box",
				sshConfigAlias: "build-via-bastion",
				host: "10.0.0.4",
				port: 2222,
				user: "kattpish",
				auth: "key",
				keyPath: "~/.ssh/id_ed25519",
			},
			{
				id: "host-2",
				name: "tailscale box",
				sshConfigAlias: null,
				host: "box.tailnet.ts.net",
				port: 22,
				user: "kattpish",
				auth: "auto",
				keyPath: null,
			},
		]);
		expect(encoded).not.toContain("keychain-account");
		expect(encoded).not.toContain("legacy-plaintext");
	});

	it("reuses pane projection across runtime-only store updates", () => {
		useStore.setState({
			spaces: [{ id: "desktop-cache", name: "Cache" }],
			layouts: { "desktop-cache": { panels: {} } },
			projects: [],
			agents: [],
		});
		const first = buildRegistry().clientPresentation;
		useStore.setState({ agentActivity: { transient: "working" } });
		const runtimeOnly = buildRegistry().clientPresentation;
		useStore.setState({
			layouts: {
				"desktop-cache": {
					panels: {
						"term:new": {
							contentComponent: "terminal",
							params: {},
						},
					},
				},
			},
		});
		const changed = buildRegistry().clientPresentation;

		expect(runtimeOnly).toBe(first);
		expect(changed).not.toBe(first);
		expect(changed.spaces[0].panes).toHaveLength(1);
	});

	it("does not reproject unchanged registry sources for runtime-only updates", async () => {
		mocks.invoke.mockClear();
		mocks.readPublishedAgentRegistry.mockClear();
		mocks.agentDisplayName.mockClear();
		useStore.setState({
			projects: [],
			agents: [agentFixture({ id: "runtime-only-agent" })],
			sshHosts: [],
			agentActivity: {},
		});
		const stop = startRegistrySync();

		try {
			await vi.waitFor(() =>
				expect(mocks.readPublishedAgentRegistry).toHaveBeenCalledOnce(),
			);
			await vi.waitFor(() => expect(mocks.agentDisplayName).toHaveBeenCalled());
			mocks.agentDisplayName.mockClear();

			useStore.setState({ agentActivity: { transient: "working" } });

			expect(mocks.agentDisplayName).not.toHaveBeenCalled();
		} finally {
			stop();
		}
	});

	it("ignores live Hmux sessions that this registry never published as Agents", async () => {
		mocks.invoke.mockClear();
		mocks.readPublishedAgentRegistry.mockClear();
		mocks.readPublishedAgentRegistry.mockResolvedValueOnce(
			JSON.stringify({
				version: 3,
				updatedAt: 1,
				sshHosts: [],
				localSessionBin: "",
				agents: [],
				projects: [],
			}),
		);
		useStore.setState({
			projects: [],
			agents: [
				agentFixture({
					id: "current-agent",
					name: "current-agent",
					projectId: "project-current",
					worktreePath: "/repo/current",
					branch: "agent/current",
					sessionId: "current-session",
					runtimeBinding: managedBindingFixture({
						sessionId: "current-session",
						workspaceId: "workspace-current",
						createIdempotencyKey: undefined,
					}),
				}),
			],
			sshHosts: [],
		});
		publishHmuxControlPlaneCensus({
			policy: {
				activation: "local_bundled_or_installed_current",
				signedReleaseFetch: "not_implemented",
				signedPackageInstall: "blocked_missing_trust_root",
			},
			protectedBuildIds: [],
			sessions: [
				hmuxSessionSummaryFixture({
					sessionId: "automatic-shell",
					workspaceId: "dure-local-shells-v1",
					inputAllowed: true,
					terminalEpoch: "epoch-shell",
					outputSeq: "1",
				}),
				hmuxSessionSummaryFixture({
					sessionId: "other-channel-agent",
					workspaceId: "workspace-other-channel",
					inputAllowed: true,
					terminalEpoch: "epoch-other",
					outputSeq: "1",
				}),
			],
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const stop = startRegistrySync();

		try {
			await vi.waitFor(() =>
				expect(mocks.readPublishedAgentRegistry).toHaveBeenCalledOnce(),
			);
			await vi.waitFor(() =>
				expect(
					mocks.invoke.mock.calls.filter(
						([command]) => command === "write_agent_registry",
					),
				).toHaveLength(1),
			);
			expect(warn).not.toHaveBeenCalledWith(
				expect.stringContaining("lack hydrated Agent metadata"),
			);
		} finally {
			stop();
			warn.mockRestore();
		}
	});

	it("publishes hydrated store absence even when the prior managed Host is live", async () => {
		mocks.invoke.mockClear();
		mocks.readPublishedAgentRegistry.mockClear();
		mocks.reconcileCleanup.mockClear();
		mocks.recoverRemoteCleanup.mockClear();
		useStore.setState({ projects: [], agents: [], sshHosts: [] });
		publishHmuxControlPlaneCensus({
			policy: {
				activation: "local_bundled_or_installed_current",
				signedReleaseFetch: "not_implemented",
				signedPackageInstall: "blocked_missing_trust_root",
			},
			protectedBuildIds: [],
			sessions: [
				hmuxSessionSummaryFixture({
					sessionId: "managed-orphan",
					inputAllowed: true,
					terminalEpoch: "epoch-1",
					outputSeq: "1",
				}),
			],
		});
		const stop = startRegistrySync();

		try {
			await vi.waitFor(() =>
				expect(mocks.readPublishedAgentRegistry).toHaveBeenCalledOnce(),
			);
			expect(mocks.recoverRemoteCleanup).toHaveBeenCalledOnce();
			await vi.waitFor(() => {
				const publication = mocks.invoke.mock.calls
					.filter(([command]) => command === "write_agent_registry")
					.map(([, payload]) => JSON.parse(String(payload?.json)))
					.find(({ agents }) => agents.length === 0);
				expect(publication).toBeDefined();
			});
		} finally {
			stop();
		}
	});

	it("does not republish an Agent explicitly removed from the hydrated store", async () => {
		mocks.invoke.mockClear();
		mocks.readPublishedAgentRegistry.mockClear();
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
			agents: [
				agentFixture({
					id: "prior-agent",
					name: "prior-agent",
					worktreePath: "/repo/prior",
					branch: "agent/prior",
					sessionId: "managed-orphan",
					runtimeBinding: managedBindingFixture({
						sessionId: "managed-orphan",
						createIdempotencyKey: undefined,
					}),
				}),
			],
			sshHosts: [],
		});
		publishHmuxControlPlaneCensus({
			policy: {
				activation: "local_bundled_or_installed_current",
				signedReleaseFetch: "not_implemented",
				signedPackageInstall: "blocked_missing_trust_root",
			},
			protectedBuildIds: [],
			sessions: [
				hmuxSessionSummaryFixture({
					sessionId: "managed-orphan",
					inputAllowed: true,
					terminalEpoch: "epoch-1",
					outputSeq: "1",
				}),
			],
		});
		const stop = startRegistrySync();

		try {
			await vi.waitFor(() =>
				expect(mocks.readPublishedAgentRegistry).toHaveBeenCalledOnce(),
			);
			useStore.setState((state) => ({
				agents: state.agents.filter((agent) => agent.id !== "prior-agent"),
			}));

			await vi.waitFor(() => {
				const publications = mocks.invoke.mock.calls
					.filter(([command]) => command === "write_agent_registry")
					.map(([, payload]) => JSON.parse(String(payload?.json)));
				expect(publications[publications.length - 1]?.agents).toEqual([]);
			});
		} finally {
			stop();
		}
	});
});
