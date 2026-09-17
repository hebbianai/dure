import { describe, expect, it } from "vitest";
import {
	bindingForAgent,
	bindingFromPane,
	hmuxLocalBinding,
	hmuxManagedBinding,
	hmuxPaneConversationId,
	hmuxStandaloneBinding,
	hmuxStandalonePaneParams,
	isTerminalPaneBindingV1,
	normalizeTerminalPaneBindingV1,
	remoteHmuxManagedBinding,
	remoteHmuxStandaloneBinding,
	sameHmuxManagedLaunchBinding,
} from "@/lib/terminal/terminalBinding";
import type { Agent, Project } from "@/types";

describe("terminal bindings", () => {
	it("preserves an SSH initial-prompt receipt through persisted binding normalization", () => {
		const binding = { ...remoteHmuxManagedBinding("session", "workspace", "host", "create", "bridge"), initialPromptDigest: `sha256:${"a".repeat(64)}` };
		expect(isTerminalPaneBindingV1(binding)).toBe(true);
		expect(normalizeTerminalPaneBindingV1(JSON.parse(JSON.stringify(binding)))).toEqual(binding);
		expect(isTerminalPaneBindingV1({ ...binding, initialPromptDigest: "invalid" })).toBe(false);
	});
	it.each(["pane-opaque", "agent:previous", "ssh:previous"])(
		"reads a terminal's explicit session in %s and never substitutes the ID",
		(id) => {
			const binding = hmuxStandaloneBinding("current", "workspace");
			const pane = {
				id,
				component: "terminal",
				params: { sessionId: "current", binding },
			};
			expect(bindingFromPane(pane, [], [])).toEqual(binding);
			expect(
				bindingFromPane(
					{ ...pane, params: { ...pane.params, sessionId: "stale" } },
					[],
					[],
				),
			).toBeUndefined();
		},
	);
	it("keeps exact host and session checks for SSH content independently of pane identity", () => {
		const binding = remoteHmuxStandaloneBinding(
			"current",
			"workspace",
			"remote",
			"bridge",
		);
		const pane = {
			id: "pane-opaque",
			component: "ssh",
			params: { sessionId: "current", hostId: "remote", binding },
		};
		expect(bindingFromPane(pane, [], [])).toEqual(binding);
		expect(
			bindingFromPane(
				{ ...pane, params: { ...pane.params, hostId: "other" } },
				[],
				[],
			),
		).toBeUndefined();
		expect(
			bindingFromPane(
				{ ...pane, params: { ...pane.params, sessionId: "other" } },
				[],
				[],
			),
		).toBeUndefined();
		expect(
			bindingFromPane(
				{
					...pane,
					params: {
						...pane.params,
						binding: hmuxStandaloneBinding("current", "workspace"),
					},
				},
				[],
				[],
			),
		).toBeUndefined();
	});

	it("compares complete local managed launch bindings", () => {
		const left = hmuxManagedBinding(
			"managed-1",
			"workspace-1",
			"account-1",
			2,
			{
				runnerPrincipal: "principal-1",
				runnerInstance: "runner-1",
				channelEpoch: "7",
				hostInstanceId: "host-1",
				terminalEpoch: "terminal-1",
			},
		);

		expect(sameHmuxManagedLaunchBinding(left, { ...left })).toBe(true);
		expect(
			sameHmuxManagedLaunchBinding({ ...left, credentialGeneration: 3 }, left),
		).toBe(false);
	});

	it("accepts each durable V1 binding and refuses retired legacy shapes", () => {
		// Legacy runtimes are retired: their persisted shapes no longer validate,
		// which routes pre-migration panes to the retirement notice.
		expect(
			isTerminalPaneBindingV1({
				schemaVersion: 1,
				runtime: "legacy_session_v1",
				source: "local",
				hostId: "local",
				sessionId: "local-1",
			}),
		).toBe(false);
		expect(
			isTerminalPaneBindingV1({
				schemaVersion: 1,
				runtime: "legacy_ssh_session_v1",
				source: "ssh",
				hostId: "host-1",
				sessionId: "ssh-1",
			}),
		).toBe(false);
		expect(
			isTerminalPaneBindingV1(hmuxLocalBinding("hmux-1", "workspace-1")),
		).toBe(true);
		expect(
			isTerminalPaneBindingV1(
				hmuxStandaloneBinding("standalone-1", "workspace-1"),
			),
		).toBe(true);
		expect(
			isTerminalPaneBindingV1(hmuxManagedBinding("managed-1", "workspace-1")),
		).toBe(true);
	});

	it("persists only a complete exact managed conversation identity fence", () => {
		const binding = {
			...hmuxManagedBinding("managed-1", "workspace-1"),
			conversationIdentity: {
				schemaVersion: 1 as const,
				sessionId: "managed-1",
				workspaceId: "workspace-1",
				runnerPrincipal: "local-user",
				runnerInstance: "runner-1",
				channelEpoch: "1",
				hostInstanceId: "host-1",
				terminalEpoch: "terminal-1",
				revision: "2",
				observedThroughOutputSeq: "3",
				providerId: "codex" as const,
				conversationId: "conversation-1",
				source: "provider_event" as const,
			},
		};

		expect(isTerminalPaneBindingV1(binding)).toBe(true);
		expect(hmuxPaneConversationId(binding)).toBe("conversation-1");
		expect(
			hmuxPaneConversationId(hmuxStandaloneBinding("standalone-1", "workspace-1")),
		).toBeUndefined();
		expect(normalizeTerminalPaneBindingV1(binding)).toEqual(binding);
		expect(
			normalizeTerminalPaneBindingV1({
				...binding,
				conversationIdentity: {
					...binding.conversationIdentity,
					terminalEpoch: "",
				},
			}),
		).toEqual(hmuxManagedBinding("managed-1", "workspace-1"));
		expect(
			normalizeTerminalPaneBindingV1({
				...binding,
				conversationIdentity: {
					...binding.conversationIdentity,
					revision: "18446744073709551616",
				},
			}),
		).toEqual(hmuxManagedBinding("managed-1", "workspace-1"));
		expect(
			normalizeTerminalPaneBindingV1({
				...binding,
				conversationIdentity: {
					...binding.conversationIdentity,
					conversationId: "unsafe;command",
				},
			}),
		).toEqual(hmuxManagedBinding("managed-1", "workspace-1"));
	});

  it("preserves a remote provider report only with its complete binding", () => {
    const stopFence = {
      runnerPrincipal: "remote-user",
      runnerInstance: "runner-1",
      channelEpoch: "1",
      hostInstanceId: "host-1",
      terminalEpoch: "terminal-1",
    };
    const conversationIdentity = {
      schemaVersion: 1 as const,
      sessionId: "managed-1",
      workspaceId: "workspace-1",
      ...stopFence,
      revision: "1",
      observedThroughOutputSeq: "4",
      providerId: "codex" as const,
      conversationId: "conversation-1",
      source: "provider_event" as const,
    };
    const binding = {
      ...remoteHmuxManagedBinding(
        "managed-1",
        "workspace-1",
        "remote-host-1",
        "bridge-1",
        "create-1",
        stopFence,
      ),
      conversationIdentity,
    };

    expect(isTerminalPaneBindingV1(binding)).toBe(true);
    expect(normalizeTerminalPaneBindingV1(binding)).toEqual(binding);
    expect(
      normalizeTerminalPaneBindingV1({
        ...binding,
        conversationIdentity: {
          ...conversationIdentity,
          workspaceId: "workspace-stale",
        },
      }),
    ).toEqual(
      remoteHmuxManagedBinding(
        "managed-1",
        "workspace-1",
        "remote-host-1",
        "bridge-1",
        "create-1",
        stopFence,
      ),
    );
    expect(
      normalizeTerminalPaneBindingV1({
        ...binding,
        conversationIdentity: {
          ...conversationIdentity,
          terminalEpoch: "terminal-stale",
        },
      }),
    ).toEqual(
      remoteHmuxManagedBinding(
        "managed-1",
        "workspace-1",
        "remote-host-1",
        "bridge-1",
        "create-1",
        stopFence,
      ),
    );
  });

	it("preserves only a valid provider-scoped remote credential profile", () => {
		const binding = remoteHmuxManagedBinding(
			"managed-remote-1",
			"workspace-1",
			"host-1",
			"bridge-1",
			"create-1",
			undefined,
			"credential-1",
			".dure/accounts/codex-work",
		);

		expect(isTerminalPaneBindingV1(binding)).toBe(true);
		expect(normalizeTerminalPaneBindingV1(binding)).toEqual(binding);
		expect(
			normalizeTerminalPaneBindingV1({
				...binding,
				credentialId: undefined,
			}),
		).toEqual({ ...binding, credentialId: undefined });
		expect(
			isTerminalPaneBindingV1({
				...binding,
				credentialId: undefined,
			}),
		).toBe(true);
		expect(
			normalizeTerminalPaneBindingV1({
				...binding,
				credentialProfileDirectory: undefined,
			}),
		).toEqual({ ...binding, credentialProfileDirectory: undefined });
		expect(
			isTerminalPaneBindingV1({
				...binding,
				credentialProfileDirectory: undefined,
			}),
		).toBe(true);
		expect(
			normalizeTerminalPaneBindingV1({
				...binding,
				credentialProfileDirectory: ".dure/accounts/../stolen",
			}),
		).toEqual(
			remoteHmuxManagedBinding(
				"managed-remote-1",
				"workspace-1",
				"host-1",
				"bridge-1",
				"create-1",
				undefined,
				"credential-1",
			),
		);
	});

	it("persists only a non-secret backend profile route on managed bindings", () => {
		const local = hmuxManagedBinding(
			"managed-local-1",
			"workspace-1",
			undefined,
			undefined,
			undefined,
			"local-primary",
		);
		const remote = remoteHmuxManagedBinding(
			"managed-remote-1",
			"workspace-1",
			"host-1",
			"bridge-1",
			"create-1",
			undefined,
			undefined,
			undefined,
			"remote-a",
		);

		expect(isTerminalPaneBindingV1(local)).toBe(true);
		expect(isTerminalPaneBindingV1(remote)).toBe(true);
		expect(normalizeTerminalPaneBindingV1(local)).toEqual(local);
		expect(normalizeTerminalPaneBindingV1(remote)).toEqual(remote);
		expect(
			normalizeTerminalPaneBindingV1({
				...remote,
				backendProfileId: "unsafe;profile",
			}),
		).toEqual(
			remoteHmuxManagedBinding(
				"managed-remote-1",
				"workspace-1",
				"host-1",
				"bridge-1",
				"create-1",
			),
		);
	});

	it("rejects malformed or secret-bearing lookalikes", () => {
		expect(
			isTerminalPaneBindingV1({
				...hmuxManagedBinding("managed-1", "workspace-1", "credential-1"),
				authToken: "must-never-persist",
			}),
		).toBe(false);
		expect(
			normalizeTerminalPaneBindingV1({
				...hmuxManagedBinding("managed-1", "workspace-1", "credential-1", 7),
				authToken: "must-never-persist",
			}),
		).toEqual({
			...hmuxManagedBinding("managed-1", "workspace-1", "credential-1", 7),
			createIdempotencyKey: "managed-1",
		});
		expect(
			isTerminalPaneBindingV1({
				...hmuxManagedBinding("managed-1", "workspace-1"),
				credentialGeneration: -1,
			}),
		).toBe(false);
		expect(
			isTerminalPaneBindingV1({
				...hmuxManagedBinding("managed-1", "workspace-1"),
				credentialGeneration: 7,
			}),
		).toBe(false);
		expect(() =>
			hmuxManagedBinding("managed-1", "workspace-1", undefined, 7),
		).toThrow(/requires a non-secret credential reference/);
	});

	it("upgrades an existing observer pane without losing pane parameters", () => {
		const params = hmuxStandalonePaneParams(
			{
				sessionId: "standalone-1",
				cwd: "/old",
				command: "codex",
				binding: hmuxLocalBinding("standalone-1", "workspace-1"),
			},
			"standalone-1",
			"workspace-1",
			"/new",
		);

		expect(params).toEqual({
			sessionId: "standalone-1",
			cwd: "/new",
			command: "codex",
			binding: hmuxStandaloneBinding("standalone-1", "workspace-1"),
		});
	});

	it("uses an explicit managed Agent binding and leaves bindingless records unbound", () => {
		const project: Project = {
			id: "project-1",
			name: "repo",
			path: "/repo",
			kind: "local",
			isRepo: true,
		};
		const legacy: Agent = {
			id: "legacy",
			name: "legacy",
			provider: "claude",
			projectId: project.id,
			worktreePath: project.path,
			branch: "main",
			sessionId: "legacy",
			sessionKind: "pty",
		};
		const managed: Agent = {
			...legacy,
			id: "managed",
			sessionId: "managed",
			runtimeBinding: {
				...hmuxManagedBinding("managed", project.id),
				credentialId: "credential-1",
			},
		};

		expect(bindingForAgent(legacy, [project])).toBeUndefined();
		expect(bindingForAgent(managed, [project])).toEqual(
			expect.objectContaining({
				runtime: "hmux_managed_v1",
				credentialId: "credential-1",
			}),
		);

		const stalePaneBinding = hmuxManagedBinding("managed", project.id);
		const currentFence = {
			runnerPrincipal: "principal-1",
			runnerInstance: "runner-1",
			channelEpoch: "7",
			hostInstanceId: "host-1",
			terminalEpoch: "terminal-1",
		};
		managed.runtimeBinding = {
			...hmuxManagedBinding("managed", project.id),
			credentialId: "credential-1",
			stopFence: currentFence,
		};
		expect(
			bindingFromPane(
				{
					id: "agent:managed",
					component: "agent",
					params: {
						agentRef: { agentId: managed.id },
						agentId: legacy.id,
						binding: stalePaneBinding,
					},
				},
				[legacy, managed],
				[project],
			),
		).toMatchObject({ stopFence: currentFence });
		expect(
			bindingFromPane(
				{
					id: "agent:missing",
					component: "agent",
					params: { agentRef: { agentId: "missing" }, binding: stalePaneBinding },
				},
				[legacy, managed],
				[project],
			),
		).toBeUndefined();
		expect(
			bindingFromPane(
				{
					id: "agent:legacy",
					component: "agent",
					params: { agentRef: { agentId: legacy.id }, binding: stalePaneBinding },
				},
				[legacy, managed],
				[project],
			),
		).toBeUndefined();
	});
});
