import type { DureBackendInvoke } from "@/lib/ipc/dureBackend";
import type { ExistingWorktreeRef } from "@/lib/ipc/git";
import type { GitCheckoutInstanceV1 } from "@/lib/scm/worktrees/gitCheckoutProtocol";
import { worktreeDirName } from "@/lib/scm/worktrees/worktreePlan";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

interface AgentRunFixtureOptions {
	projectId?: string;
	providerId?: string;
	backendGeneration?: string;
	planBackendGeneration?: string;
	interactionProfile?: "native_cli" | "structured_protocol";
	/** Canonical backend result, independent of the requested checkout path. */
	checkoutRoot?: string;
	mutateApplyResult?: (
		result: Record<string, unknown>,
	) => Record<string, unknown>;
}

export function createAgentRunBackendFixture(
	options: AgentRunFixtureOptions = {},
): {
	invokeCommand: DureBackendInvoke;
	operations: string[];
} {
	const projectId = options.projectId ?? "project-repo";
	const providerId = options.providerId ?? "claude";
	const backendGeneration = options.backendGeneration ?? "generation-1";
	const routeAuthority = testDureBackendRouteAuthority(
		"dure-local",
		backendGeneration,
	);
	const planBackendGeneration =
		options.planBackendGeneration ?? backendGeneration;
	const operationId = "agent-spawn-operation-1";
	const planToken = `sha256:${"a".repeat(64)}`;
	const rootId = `root_${"b".repeat(32)}`;
	const repositoryId = `repo_${"c".repeat(32)}`;
	const operations: string[] = [];
	const interactionProfile = options.interactionProfile ?? "native_cli";
	let previewBody: Record<string, unknown> | undefined;
	let permissionOverride:
		| "require_approvals"
		| "auto_edit"
		| "bypass_approvals"
		| null = null;
	const plannedWorkspaceId = () => {
		const worktree = previewBody?.worktree as
			| { kind: "existing_workspace"; source?: { workspaceId?: string } }
			| undefined;
		return worktree?.kind === "existing_workspace" &&
			typeof worktree.source?.workspaceId === "string"
			? worktree.source.workspaceId
			: "workspace-run-1";
	};

	const plan = () => ({
		schemaVersion: 1,
		operationId,
		authority: {
			backendId: "dure-local",
			backendGeneration: planBackendGeneration,
			projectId,
			rootId,
			repositoryId,
		},
		request: previewBody,
		agentId: "agent-run-1",
		workspaceId: plannedWorkspaceId(),
		launch:
			interactionProfile === "native_cli"
				? {
						interactionProfile,
						sessionId: "session-run-1",
						runtime: {
							runtimeKindId: "runtime.hmux",
							requiredCapabilities: ["runtime.managed_create_v1"],
						},
					}
				: { interactionProfile },
		providerLaunchDefaults: {
			schemaVersion: 1,
			revision: 0,
			fingerprint: `sha256:${"d".repeat(64)}`,
			permissionOverride,
		},
		planToken,
	});
	const workspaceEvidence = () => {
		const worktree = previewBody?.worktree as
			| { kind: "project_root" }
			| { kind: "dedicated"; branch: string }
			| { kind: "existing_workspace" }
			| undefined;
		if (worktree?.kind !== "dedicated") {
			return {
				stage: "worktree",
				workspace_id: plannedWorkspaceId(),
				disposition: "adopted_existing",
			};
		}
		return {
			stage: "worktree",
			workspace_id: plannedWorkspaceId(),
			disposition: "created_dure_owned",
			lease: {
				lease_id: "workspace-lease:workspace-run-1",
				directory_name: worktreeDirName(worktree.branch),
				retirement_id: "workspace-retire:workspace-run-1",
			},
		};
	};

	const nativeLaunchStage = () => ({
		stage: "runtime_launch",
		attempt: 1,
		inputs: { stage: "runtime_launch" },
		evidence: {
			stage: "runtime_launch",
			session: {
				sessionId: "session-run-1",
				workspaceId: plannedWorkspaceId(),
				providerId,
				runnerPrincipal: "runner-principal",
				runnerInstance: "runner-instance",
				channelEpoch: "1",
				hostInstanceId: "host-instance",
				terminalEpoch: "terminal-epoch",
			},
		},
	});
	const structuredLaunchStage = () => ({
		stage: "structured_launch",
		attempt: 1,
		inputs: { stage: "structured_launch" },
		evidence: {
			stage: "structured_launch",
			binding: {
				schemaVersion: 1,
				interactionSessionId: "interaction-run-1",
				agentId: "agent-run-1",
				providerId,
				executionProfile: previewBody?.executionProfile,
				providerConversationRef:
					(previewBody?.providerConversationRef as string | null) ?? null,
				runtime: {
					runtimeGeneration: "structured-runtime-1",
					providerEpoch: "structured-provider-1",
				},
				timelineEpoch: "structured-timeline-1",
				bindingRevision: 1,
				historyComplete: true,
				createdAtMs: 1,
				updatedAtMs: 1,
			},
		},
	});

	const checkoutRegistrationFields = () => {
		const worktree = previewBody?.worktree as
			| { kind: string; instance?: GitCheckoutInstanceV1 }
			| undefined;
		const instance =
			worktree?.kind === "existing_checkout"
				? worktree.instance
				: options.checkoutRoot
					? {
							schemaVersion: 1,
							canonicalPath: options.checkoutRoot,
							gitCommonDir: "/repo/.git",
							gitDir: "/repo/.git/worktrees/fixture",
							instanceToken: `dwt1_${"a".repeat(32)}`,
						}
					: undefined;
		return instance
			? { checkoutRegistration: { repositoryPath: "/repo", instance } }
			: {};
	};
	const receipt = (succeeded: boolean) => ({
		schemaVersion: 1,
		operationId,
		plan: plan(),
		state: succeeded ? "succeeded" : "applying",
		...(succeeded ? checkoutRegistrationFields() : {}),
		lastSequence: succeeded ? 6 : 1,
		completed: succeeded
			? [
					{
						stage: "worktree",
						attempt: 1,
						inputs: { stage: "worktree" },
						evidence: workspaceEvidence(),
					},
					interactionProfile === "native_cli"
						? nativeLaunchStage()
						: structuredLaunchStage(),
				]
			: [],
		recovery: succeeded
			? { kind: "none" }
			: { kind: "continue", stage: "worktree", next_attempt: 1 },
		terminalCode: null,
		createdAtMs: 1,
		updatedAtMs: succeeded ? 2 : 1,
	});

	const invokeCommand: DureBackendInvoke = async (command, arguments_) => {
		if (command === "dure_backend_route_assert") return routeAuthority;
		if (command !== "dure_backend_request") throw new Error(command);
		const request = arguments_ as {
			operation: string;
			body: Record<string, unknown>;
		};
		operations.push(request.operation);
		if (request.operation === "projects.register") {
			return {
				schemaVersion: 1,
				backendId: "dure-local",
				backendGeneration,
				routeAuthority,
				result: { schemaVersion: 1 },
			};
		}
		if (request.operation === "provider_launch_defaults.get") {
			return {
				schemaVersion: 1,
				backendId: "dure-local",
				backendGeneration,
				routeAuthority,
				result: {
					schemaVersion: 1,
					document: {
						schemaVersion: 1,
						revision: 0,
						defaults: {},
						fingerprint: `sha256:${"d".repeat(64)}`,
					},
				},
			};
		}
		if (request.operation === "agent_spawn.preview") {
			permissionOverride =
				(request.body.permissionOverride as typeof permissionOverride) ?? null;
			const incomingWorktree = request.body.worktree as
				| {
						kind: "existing_workspace";
						source_agent_id: string;
						workspace_id: string;
				  }
				| { kind: string };
			let worktree =
				incomingWorktree.kind === "existing_workspace" &&
				"source_agent_id" in incomingWorktree &&
				"workspace_id" in incomingWorktree
					? {
							kind: "existing_workspace",
							source: {
								sourceAgentId: incomingWorktree.source_agent_id,
								workspaceId: incomingWorktree.workspace_id,
								projectId,
								providerId,
								workspaceRoot: "/repo/.worktrees/source",
								workspaceBaseCommitSha: "e".repeat(40),
								runtimeSelection: {
									revision: 4,
									interactionProfile: "structured_protocol",
									executionProfile: request.body.executionProfile,
									permissionMode: "default",
									model: null,
									effort: null,
								},
								runtimeBinding: {
									interactionProfile: "structured_protocol",
									interactionSessionId: "interaction-source-1",
									providerConversationRef: "conversation-source-1",
									runtime: {
										runtimeGeneration: "structured-runtime-source-1",
										providerEpoch: "structured-provider-source-1",
									},
									timelineEpoch: "structured-timeline-source-1",
									bindingRevision: 3,
								},
							},
						}
					: request.body.worktree;
			if (
				incomingWorktree.kind === "existing_checkout" &&
				"reference" in incomingWorktree
			) {
				const reference = incomingWorktree.reference as ExistingWorktreeRef;
				worktree = {
					kind: "existing_checkout",
					branch: reference.branch,
					base_commit_sha: reference.head,
					instance: {
						schemaVersion: 1,
						canonicalPath: reference.canonicalPath,
						gitCommonDir: reference.gitCommonDir,
						gitDir: reference.gitDir,
						instanceToken: `dwt1_${"a".repeat(32)}`,
					},
				};
			}
			previewBody = {
				...request.body,
				worktree,
				projectId,
				permissionMode:
					permissionOverride === "auto_edit"
						? "auto_edit"
						: permissionOverride === "bypass_approvals"
							? "skip_permissions"
							: "default",
			};
			delete previewBody.projectPath;
			delete previewBody.permissionOverride;
			return {
				schemaVersion: 1,
				backendId: "dure-local",
				backendGeneration,
				routeAuthority,
				result: { schemaVersion: 1, receipt: receipt(false) },
			};
		}
		if (request.operation === "agent_spawn.apply") {
			const result = { schemaVersion: 1, receipt: receipt(true) };
			return {
				schemaVersion: 1,
				backendId: "dure-local",
				backendGeneration,
				routeAuthority,
				result: options.mutateApplyResult
					? options.mutateApplyResult(result)
					: result,
			};
		}
		throw new Error(request.operation);
	};

	return { invokeCommand, operations };
}
