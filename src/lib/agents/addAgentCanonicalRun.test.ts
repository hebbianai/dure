import { beforeEach, describe, expect, it, vi } from "vitest";

const { backendRequest, registerCredential, resolveRoute, routeAuthority } =
	vi.hoisted(() => ({
		backendRequest: vi.fn().mockResolvedValue({}),
		registerCredential: vi.fn().mockResolvedValue({
			kind: "credential_reference",
			reference_id: "account-work",
			credential_generation: "credential-generation-1",
		}),
		resolveRoute: vi.fn(),
		routeAuthority: {
			schemaVersion: 1 as const,
			profileId: "local",
			revision: `sha256:${"a".repeat(64)}`,
			backend: { id: "dure-local", generation: "generation-1" },
			target: { source: "local" as const, hostId: "local" as const },
		},
	}));

vi.mock("@/lib/cli/cliManagedRunPresentation", async (importOriginal) => ({
	...(await importOriginal<object>()),
	presentManagedRun: vi.fn().mockResolvedValue({}),
}));
vi.mock(
	"@/lib/cli/managedRunBackgroundPresentation",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		presentManagedRunInBackground: vi.fn().mockResolvedValue({}),
	}),
);
vi.mock("@/lib/agents/structuredRunPresentation", async (importOriginal) => ({
	...(await importOriginal<object>()),
	presentStructuredRun: vi.fn().mockResolvedValue({}),
	presentStructuredRunInBackground: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/ipc/git", () => ({
	gitExecLocal: vi.fn().mockResolvedValue({
		stdout: "a".repeat(40),
		stderr: "",
		code: 0,
	}),
}));
vi.mock("@/lib/ipc/dureBackend", () => ({
	createDureBackendRequester: () => backendRequest,
	resolveSelectedDureBackendRouteAuthority: resolveRoute,
}));
vi.mock("@/lib/ipc/dureProviderCredentialProfile", () => ({
	registerDureProviderCredentialProfile: registerCredential,
	supportsDureProviderCredentialSpawn: () => true,
}));

const run = vi.fn().mockResolvedValue({
	schemaVersion: 1,
	backend: { id: "dure-local", generation: "generation-1" },
	operationId: "op-1",
	agentId: "agent-1",
	agentName: "fix-x",
	projectId: "p1",
	providerId: "claude",
	executionProfile: { kind: "provider_default" },
	interactionProfile: "native_cli",
	sessionId: "s1",
	workspaceId: "w1",
	worktree: {
		kind: "dedicated",
		branch: "agent/fix-x",
		directoryName: "fix-x",
	},
	generation: {},
	permissionMode: "default",
});
vi.mock("@/lib/ipc/dureAgentRun", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createDureAgentRunTransport: () => ({ run }),
}));

import {
	prepareCanonicalAddAgentRun,
	runCanonicalAddAgent,
	runCanonicalAddAgentInBackground,
	runCanonicalAddAgentPresenting,
	runPreparedCanonicalAddAgentPresenting,
	supportsCanonicalAddAgentRun,
} from "@/lib/agents/addAgentCanonicalRun";
import {
	presentStructuredRun,
	presentStructuredRunInBackground,
} from "@/lib/agents/structuredRunPresentation";
import {
	ManagedRunPaneCommittedError,
	presentManagedRun,
} from "@/lib/cli/cliManagedRunPresentation";
import { presentManagedRunInBackground } from "@/lib/cli/managedRunBackgroundPresentation";
import { gitExecLocal } from "@/lib/ipc/git";

beforeEach(() => {
	backendRequest.mockClear();
	registerCredential.mockClear();
	resolveRoute.mockReset().mockResolvedValue(routeAuthority);
	vi.mocked(presentStructuredRun).mockClear();
	vi.mocked(presentStructuredRunInBackground).mockClear();
});

describe("runCanonicalAddAgent", () => {
	it("freezes the selected existing branch instead of repository HEAD", async () => {
		vi.mocked(gitExecLocal).mockImplementationOnce(async (_path, args) => ({
			stdout: (args[2] === "refs/heads/feature-existing^{commit}"
				? "b"
				: "a"
			).repeat(40),
			stderr: "",
			code: 0,
		}));
		const input = {
			project: {
				id: "p1",
				name: "P",
				path: "/tmp/p",
				kind: "local" as const,
				isRepo: true,
			},
			actionId: "existing-branch-action",
			agentName: "existing",
			provider: "claude" as const,
			accountId: null,
			useWorktree: true,
			worktreePlan: {
				branch: "feature-existing",
				action: "checkout-existing-branch" as const,
				mode: "existing-branch" as const,
				branchExists: true,
				worktreePath: "/tmp/p/.worktrees/feature-existing",
			},
			setupCommand: null,
		};
		const prepared = await prepareCanonicalAddAgentRun(input);
		expect(prepared.request.worktree).toEqual({
			kind: "dedicated",
			branch: "feature-existing",
			baseCommitSha: "b".repeat(40),
			branchMode: "existing",
		});
		expect(supportsCanonicalAddAgentRun(input)).toBe(true);
	});

	it.each([
		["work/trees/", "/tmp/p/work/trees/fix-x"],
		["../", "/tmp/fix-x"],
	])(
		"keeps an explicit checkout destination in canonical Run (%s)",
		async (worktreeRoot, worktreePath) => {
			const input = {
				project: {
					id: "p1",
					name: "P",
					path: "/tmp/p",
					kind: "local" as const,
					isRepo: true,
				},
				actionId: "custom-checkout-action",
				agentName: "fix-x",
				provider: "claude" as const,
				accountId: null,
				useWorktree: true,
				worktreePlan: {
					branch: "agent/fix-x",
					action: "create-new-branch" as const,
					mode: "new-branch" as const,
					branchExists: false,
					worktreeRoot,
					worktreePath,
				},
				setupCommand: null,
			};
			expect(supportsCanonicalAddAgentRun(input)).toBe(true);
			const prepared = await prepareCanonicalAddAgentRun(input);
			expect(prepared.request.worktree).toEqual({
				kind: "dedicated",
				branch: "agent/fix-x",
				baseCommitSha: "a".repeat(40),
				checkoutPath: worktreePath,
			});
		},
	);

	it("forwards prompt and model into the transport request", async () => {
		await runCanonicalAddAgent({
			project: {
				id: "p1",
				name: "P",
				path: "/tmp/p",
				kind: "local",
				isRepo: true,
			},
			actionId: "run-action-1",
			agentName: "fix-x",
			provider: "claude",
			accountId: null,
			useWorktree: true,
			worktreePlan: {
				branch: "agent/fix-x",
				action: "create-new-branch",
				worktreePath: "/tmp/p/.worktrees/fix-x",
				mode: "new-branch",
				branchExists: false,
			},
			setupCommand: null,
			spaceId: "space-1",
			windowLabel: "main",
			prompt: "fix the flicker",
			model: "gpt-5.6-sol",
			effort: "xhigh",
		} as never);
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "fix the flicker",
				model: "gpt-5.6-sol",
				effort: "xhigh",
			}),
			routeAuthority,
		);
		// A resolvable project needs no registration round-trip: registering
		// unconditionally conflicts on machines where the same root is already
		// registered under another id (CLI registrations, older runs).
		expect(backendRequest).not.toHaveBeenCalled();
	});

	it("registers a selected credential and leaves projection to the backend", async () => {
		run.mockClear();
		await runCanonicalAddAgent({
			project: {
				id: "p1",
				name: "P",
				path: "/tmp/p",
				kind: "local",
				isRepo: true,
			},
			actionId: "run-account-1",
			agentName: "fix-account",
			provider: "codex",
			accountId: "account-work",
			account: {
				id: "account-work",
				provider: "codex",
				name: "Work",
				dir: "/home/user/.dure/accounts/codex-work",
			},
			useWorktree: false,
			setupCommand: null,
			spaceId: "space-1",
			windowLabel: "main",
		} as never);

		expect(registerCredential).toHaveBeenCalledWith(
			{
				providerId: "codex",
				referenceId: "account-work",
				profileDirectoryName: "codex-work",
			},
			{ profileId: "local", routeAuthority },
		);
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-work",
					credential_generation: "credential-generation-1",
				},
			}),
			routeAuthority,
		);
	});
});

describe("prepared canonical Add Agent action", () => {
	it.each(["claude", "codex"] as const)(
		"freezes the selected checkout with the independently selected %s credential",
		async (provider) => {
			const existingCheckout = {
				canonicalPath: "/repo/user-work",
				gitCommonDir: "/repo/.git",
				gitDir: "/repo/.git/worktrees/user-work",
				branch: "user/work",
				head: "a".repeat(40),
			};
			const selected = { ...existingCheckout };
			const input = {
				project: {
					id: "project-repo",
					name: "Repo",
					path: "/repo",
					kind: "local" as const,
					isRepo: true,
				},
				actionId: "existing-checkout-action",
				agentName: "new-agent",
				provider,
				accountId: "account-work",
				account: {
					id: "account-work",
					provider,
					name: "Work",
					dir: `/accounts/${provider}-work`,
				},
				useWorktree: false,
				existingCheckout,
				setupCommand: null,
			};
			expect(supportsCanonicalAddAgentRun(input)).toBe(true);
			const pending = prepareCanonicalAddAgentRun(input);
			existingCheckout.branch = "user/changed-while-resolving-route";
			input.project.path = "/other-project";
			input.account.dir = `/accounts/${provider}-other`;
			const prepared = await pending;
			existingCheckout.branch = "user/changed-after-preparation";
			expect(prepared.input.project.path).toBe("/repo");
			expect(prepared.request).toMatchObject({
				projectPath: "/repo",
				worktree: { kind: "existing_checkout", reference: selected },
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-work",
					credential_generation: "credential-generation-1",
				},
			});
			expect(prepared.request).not.toHaveProperty("providerConversationRef");
			expect(registerCredential).toHaveBeenCalledWith(
				{
					providerId: provider,
					referenceId: "account-work",
					profileDirectoryName: `${provider}-work`,
				},
				{ profileId: "local", routeAuthority },
			);
		},
	);

	it("reuses the exact resolved request after an unknown outcome", async () => {
		run.mockClear();
		const prepared = await prepareCanonicalAddAgentRun({
			project: {
				id: "p1",
				name: "P",
				path: "/tmp/p",
				kind: "local",
				isRepo: true,
			},
			actionId: "add-dialog-action-1",
			agentName: "fix-x",
			provider: "claude",
			accountId: null,
			useWorktree: true,
			worktreePlan: {
				branch: "agent/fix-x",
				action: "create-new-branch",
				worktreePath: "/tmp/p/.worktrees/fix-x",
				mode: "new-branch",
				branchExists: false,
			},
			setupCommand: null,
		});
		run.mockRejectedValueOnce(
			Object.assign(new Error("agent_run_outcome_unknown"), {
				code: "agent_run_outcome_unknown",
				details: { retry: "same_intent" },
			}),
		);

		await expect(
			runPreparedCanonicalAddAgentPresenting(prepared, null),
		).rejects.toThrow("agent_run_outcome_unknown");
		await runPreparedCanonicalAddAgentPresenting(prepared, null);

		expect(run).toHaveBeenCalledTimes(2);
		expect(run.mock.calls[1]?.[0]).toBe(run.mock.calls[0]?.[0]);
		expect(run.mock.calls[0]?.[0]).toMatchObject({
			idempotencyKey: "add-agent:add-dialog-action-1",
			worktree: { baseCommitSha: "a".repeat(40) },
		});
		// No caller preference → the wire request must not carry the key at
		// all; the backend treats presence as an explicit surface pin.
		expect(run.mock.calls[0]?.[0]).not.toHaveProperty("interactionPreference");
	});

	it("carries the basic-mode PTY pin onto the wire request", async () => {
		run.mockClear();
		const prepared = await prepareCanonicalAddAgentRun({
			project: {
				id: "p1",
				name: "P",
				path: "/tmp/p",
				kind: "local",
				isRepo: true,
			},
			actionId: "add-dialog-action-basic-1",
			agentName: "fix-basic",
			provider: "claude",
			accountId: null,
			useWorktree: false,
			setupCommand: null,
			interactionPreference: "native_cli",
		});
		await runPreparedCanonicalAddAgentPresenting(prepared, null);
		expect(run.mock.calls[0]?.[0]).toMatchObject({
			interactionPreference: "native_cli",
		});
	});

	it("replays the frozen request through the same backend successor", async () => {
		run.mockClear();
		const prepared = await prepareCanonicalAddAgentRun({
			project: {
				id: "p1",
				name: "P",
				path: "/tmp/p",
				kind: "local",
				isRepo: true,
			},
			actionId: "add-dialog-action-2",
			agentName: "fix-y",
			provider: "claude",
			accountId: null,
			useWorktree: false,
			setupCommand: null,
		});
		const successor = {
			...routeAuthority,
			revision: `sha256:${"b".repeat(64)}`,
			backend: { ...routeAuthority.backend, generation: "generation-2" },
		};
		run.mockRejectedValueOnce(
			Object.assign(new Error("backend changed"), {
				code: "backend_transport_generation_changed",
			}),
		);
		resolveRoute.mockResolvedValueOnce(successor);

		await runPreparedCanonicalAddAgentPresenting(prepared, null);

		expect(run).toHaveBeenCalledTimes(2);
		expect(run.mock.calls[0]?.[0]).toBe(run.mock.calls[1]?.[0]);
		expect(run.mock.calls[0]?.[1]).toEqual(routeAuthority);
		expect(run.mock.calls[1]?.[1]).toEqual(successor);
	});
});

describe("project admission on preview miss", () => {
	const policy = {
		project: {
			id: "p1",
			name: "P",
			path: "/tmp/p",
			kind: "local",
			isRepo: true,
		},
		actionId: "admission-action-1",
		agentName: "fix-x",
		provider: "claude",
		accountId: null,
		useWorktree: true,
		worktreePlan: {
			branch: "agent/fix-x",
			action: "create-new-branch",
			worktreePath: "/tmp/p/.worktrees/fix-x",
			mode: "new-branch",
			branchExists: false,
		},
		setupCommand: null,
	};
	const notFound = () =>
		Object.assign(new Error("agent_spawn_project_not_found"), {
			code: "agent_spawn_project_not_found",
		});

	it("registers the project and retries once when the preview misses it", async () => {
		run.mockClear();
		run.mockRejectedValueOnce(notFound());
		const result = await runCanonicalAddAgentInBackground(policy as never);
		expect(result.agentId).toBe("agent-1");
		expect(backendRequest).toHaveBeenCalledWith(
			"projects.register",
			expect.objectContaining({ displayName: "P", root: "/tmp/p" }),
			{ kind: "exact", authority: routeAuthority },
		);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("still retries when registration loses the race to another writer", async () => {
		run.mockClear();
		run.mockRejectedValueOnce(notFound());
		backendRequest.mockRejectedValueOnce(
			Object.assign(new Error("backend_project_registration_conflict"), {
				code: "backend_project_registration_conflict",
			}),
		);
		const result = await runCanonicalAddAgentInBackground(policy as never);
		expect(result.agentId).toBe("agent-1");
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("does not register or retry on unrelated run failures", async () => {
		run.mockClear();
		run.mockRejectedValueOnce(
			Object.assign(new Error("agent_spawn_idempotency_conflict"), {
				code: "agent_spawn_idempotency_conflict",
			}),
		);
		await expect(
			runCanonicalAddAgentInBackground(policy as never),
		).rejects.toThrow("agent_spawn_idempotency_conflict");
		expect(backendRequest).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledTimes(1);
	});
});

describe("runCanonicalAddAgentInBackground", () => {
	it("forwards prompt/model into the transport and presents in the background, never through the pane path", async () => {
		run.mockClear();
		vi.mocked(presentManagedRun).mockClear();
		vi.mocked(presentManagedRunInBackground).mockClear();
		await runCanonicalAddAgentInBackground({
			project: {
				id: "p1",
				name: "P",
				path: "/tmp/p",
				kind: "local",
				isRepo: true,
			},
			actionId: "background-action-1",
			agentName: "fix-x",
			provider: "claude",
			accountId: null,
			useWorktree: true,
			worktreePlan: {
				branch: "agent/fix-x",
				action: "create-new-branch",
				worktreePath: "/tmp/p/.worktrees/fix-x",
				mode: "new-branch",
				branchExists: false,
			},
			setupCommand: null,
			prompt: "fix the flicker",
			model: "opus",
		} as never);
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: "fix the flicker", model: "opus" }),
			routeAuthority,
		);
		expect(presentManagedRunInBackground).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent-1" }),
			{
				projectPath: "/tmp/p",
				presentationWorktree: {
					kind: "dedicated",
					branch: "agent/fix-x",
					directoryName: "fix-x",
				},
			},
		);
		expect(presentManagedRun).not.toHaveBeenCalled();
	});

	it("projects a structured receipt without invoking the Hmux presenter", async () => {
		run.mockClear();
		vi.mocked(presentManagedRunInBackground).mockClear();
		run.mockResolvedValueOnce({
			schemaVersion: 1,
			backend: { id: "dure-local", generation: "generation-1" },
			operationId: "op-chat-1",
			agentId: "agent-chat-1",
			agentName: "fix-x",
			projectId: "p1",
			providerId: "claude",
			executionProfile: { kind: "provider_default" },
			workspaceId: "w-chat-1",
			worktree: { kind: "project_root" },
			permissionMode: "default",
			interactionProfile: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: "interaction-chat-1",
		});

		await runCanonicalAddAgentInBackground({
			project: {
				id: "p1",
				name: "P",
				path: "/tmp/p",
				kind: "local",
				isRepo: true,
			},
			actionId: "background-action-2",
			agentName: "fix-x",
			provider: "claude",
			accountId: null,
			useWorktree: false,
			setupCommand: null,
		} as never);

		expect(presentStructuredRunInBackground).toHaveBeenCalledWith(
			expect.objectContaining({ interactionSessionId: "interaction-chat-1" }),
			{
				projectPath: "/tmp/p",
				presentationWorktree: { kind: "project_root" },
			},
		);
		expect(presentManagedRunInBackground).not.toHaveBeenCalled();
	});
});

describe("runCanonicalAddAgentPresenting", () => {
	const policy = {
		project: {
			id: "p1",
			name: "P",
			path: "/tmp/p",
			kind: "local",
			isRepo: true,
		},
		actionId: "presentation-action-1",
		agentName: "fix-x",
		provider: "claude",
		accountId: null,
		useWorktree: true,
		worktreePlan: {
			branch: "agent/fix-x",
			action: "create-new-branch",
			worktreePath: "/tmp/p/.worktrees/fix-x",
			mode: "new-branch",
			branchExists: false,
		},
		setupCommand: null,
		prompt: "fix the flicker",
	};

	it("opens the pane in the given target space", async () => {
		run.mockClear();
		vi.mocked(presentManagedRun).mockClear();
		vi.mocked(presentManagedRunInBackground).mockClear();
		const position = {
			referenceGroup: { id: "drop-group" },
			direction: "above",
		};
		const result = await runCanonicalAddAgentPresenting(policy as never, {
			spaceId: "space-1",
			windowLabel: "main",
			referencePanelId: "agent:source",
			position,
		});
		expect(result.disposition).toBe("pane");
		expect(presentManagedRun).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				spaceId: "space-1",
				windowLabel: "main",
				referencePanelId: "agent:source",
				panePosition: position,
			}),
		);
		expect(presentManagedRunInBackground).not.toHaveBeenCalled();
	});

	it.each(["claude", "codex", "opencode", "pi"] as const)(
		"opens %s structured Chat directly without a native pane attachment",
		async (provider) => {
			run.mockClear();
			vi.mocked(presentManagedRun).mockClear();
			run.mockResolvedValueOnce({
				schemaVersion: 1,
				backend: { id: "dure-local", generation: "generation-1" },
				operationId: "op-chat-1",
				agentId: "agent-chat-1",
				agentName: "fix-x",
				projectId: "p1",
				providerId: provider,
				executionProfile: { kind: "provider_default" },
				workspaceId: "w-chat-1",
				worktree: { kind: "project_root" },
				permissionMode: "default",
				interactionProfile: "structured_protocol",
				backendProfileId: "local",
				interactionSessionId: "interaction-chat-1",
			});

			const position = { floating: { x: 40, y: 60, width: 700 } };
			await runCanonicalAddAgentPresenting(
				{ ...policy, provider, accountId: null, useWorktree: false } as never,
				{ spaceId: "space-1", windowLabel: "main", position },
			);

			expect(presentStructuredRun).toHaveBeenCalledWith(
				expect.objectContaining({ interactionSessionId: "interaction-chat-1" }),
				{
					projectPath: "/tmp/p",
					presentationWorktree: { kind: "project_root" },
					spaceId: "space-1",
					windowLabel: "main",
					position,
				},
			);
			expect(presentManagedRun).not.toHaveBeenCalled();
		},
	);

	it("falls back to the background projection when the pane cannot open", async () => {
		run.mockClear();
		vi.mocked(presentManagedRun).mockClear();
		vi.mocked(presentManagedRunInBackground).mockClear();
		vi.mocked(presentManagedRun).mockRejectedValueOnce(
			new Error("client_space_window_changed"),
		);
		const result = await runCanonicalAddAgentPresenting(policy as never, {
			spaceId: "space-1",
			windowLabel: "main",
		});
		expect(result.disposition).toBe("background");
		expect(result.run.agentId).toBe("agent-1");
		expect(run).toHaveBeenCalledTimes(1);
		expect(presentManagedRunInBackground).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent-1" }),
			{
				projectPath: "/tmp/p",
				presentationWorktree: {
					kind: "dedicated",
					branch: "agent/fix-x",
					directoryName: "fix-x",
				},
			},
		);
	});

	it("keeps pane disposition when only post-open attachment confirmation fails", async () => {
		run.mockClear();
		vi.mocked(presentManagedRun).mockClear();
		vi.mocked(presentManagedRunInBackground).mockClear();
		vi.mocked(presentManagedRun).mockRejectedValueOnce(
			new ManagedRunPaneCommittedError(
				{
					spaceId: "space-1",
					desktopId: "space-1",
					panelId: "agent:agent-1",
					agentId: "agent-1",
					sessionId: "s1",
					workspaceId: "w1",
					runtime: "hmux_managed_v1",
					outcome: "created",
				},
				Object.assign(new Error("attachment timed out"), {
					code: "hmux_pane_attachment_timeout",
				}),
			),
		);

		const result = await runCanonicalAddAgentPresenting(policy as never, {
			spaceId: "space-1",
			windowLabel: "main",
		});

		expect(result.disposition).toBe("pane");
		expect(presentManagedRunInBackground).not.toHaveBeenCalled();
	});

	it("uses one self-contained workspace snapshot for foreground and fallback presentation", async () => {
		run.mockClear();
		vi.mocked(presentManagedRun).mockClear();
		vi.mocked(presentManagedRunInBackground).mockClear();
		vi.mocked(presentManagedRun).mockRejectedValueOnce(
			new Error("client_space_window_changed"),
		);
		run.mockResolvedValueOnce({
			schemaVersion: 1,
			backend: { id: "dure-local", generation: "generation-1" },
			operationId: "op-history-1",
			agentId: "agent-history-1",
			agentName: "fix-x",
			projectId: "p1",
			providerId: "claude",
			executionProfile: { kind: "provider_default" },
			providerConversationRef: "threads/2026-08-30:turn_1",
			interactionProfile: "native_cli",
			preparedSessionId: "s-history-1",
			sessionId: "s-history-1",
			launchIdempotencyKey: "spawn-runtime:op-history-1",
			workspaceId: "workspace-source",
			worktree: {
				kind: "existing_workspace",
				sourceAgentId: "agent-source",
				rootPath: "/tmp/p/.worktrees/source",
			},
			generation: {},
			permissionMode: "default",
		});
		const presentationWorktree = {
			kind: "existing_workspace",
			sourceAgentId: "agent-source",
			rootPath: "/tmp/p/.worktrees/source",
			branch: "agent/source",
		};
		const existingPolicy = {
			...policy,
			useWorktree: false,
			existingWorkspace: {
				sourceAgentId: "agent-source",
				workspaceId: "workspace-source",
				branch: presentationWorktree.branch,
				executionProfile: { kind: "provider_default" },
				providerConversationRef: "threads/2026-08-30:turn_1",
				routeAuthority,
			},
		};

		await runCanonicalAddAgentPresenting(existingPolicy as never, {
			spaceId: "space-1",
			windowLabel: "main",
		});

		expect(presentManagedRun).toHaveBeenCalledWith(
			expect.objectContaining({ presentationWorktree }),
		);
		expect(presentManagedRunInBackground).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent-history-1" }),
			{ projectPath: "/tmp/p", presentationWorktree },
		);
	});

	it("projects in the background directly when no target is available", async () => {
		run.mockClear();
		vi.mocked(presentManagedRun).mockClear();
		vi.mocked(presentManagedRunInBackground).mockClear();
		const result = await runCanonicalAddAgentPresenting(policy as never, null);
		expect(result.disposition).toBe("background");
		expect(presentManagedRun).not.toHaveBeenCalled();
		expect(presentManagedRunInBackground).toHaveBeenCalled();
	});

	it("retries background projection with the same prepared action after the run succeeds", async () => {
		run.mockClear();
		vi.mocked(presentManagedRunInBackground).mockClear();
		vi.mocked(presentManagedRunInBackground).mockRejectedValueOnce(
			new Error("projection unavailable"),
		);
		const prepared = await prepareCanonicalAddAgentRun(policy as never);

		await expect(
			runPreparedCanonicalAddAgentPresenting(prepared, null),
		).rejects.toMatchObject({
			code: "agent_run_projection_failed",
			message:
				"agent_run_projection_failed: Error: projection unavailable",
			details: {
				retry: "same_intent",
				agentId: "agent-1",
				operationId: "op-1",
			},
		});
		await expect(
			runPreparedCanonicalAddAgentPresenting(prepared, null),
		).resolves.toMatchObject({ disposition: "background" });
		expect(run).toHaveBeenCalledTimes(2);
		expect(run.mock.calls[0]?.[0]).toBe(run.mock.calls[1]?.[0]);
	});
});
