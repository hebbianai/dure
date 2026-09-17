import { describe, expect, it } from "vitest";
import {
	agentRuntimeReplacementResultMatches,
	type AgentRuntimeRepairTargetV1,
	resolveAgentRuntimeReplacementTarget,
} from "@/lib/agents/agentRuntimeReplacementTarget";
import type {
	DureAgentRuntimeRepairIntentV1,
	DureAgentRuntimeTransitionResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

function repairRequired(
	overrides: Partial<DureAgentRuntimeRepairIntentV1> = {},
): DureAgentRuntimeRepairIntentV1 {
	const routeAuthority = testDureBackendRouteAuthority(
		"dure-local",
		"generation-1",
	);
	return {
		state: "repair_required",
		agentId: "agent-1",
		operationId: "operation-1",
		journalRevision: 3,
		sourceSelectionRevision: 2,
		sourceInteractionProfile: "native_cli",
		sourceExecutionProfile: { kind: "provider_default" },
		sourceLaunchSelection: {
			model: null,
			effort: null,
			permissionMode: "default",
		},
		targetInteractionProfile: "native_cli",
		targetExecutionProfile: { kind: "provider_default" },
		targetLaunchSelection: {
			model: null,
			effort: null,
			permissionMode: "default",
		},
		failureKind: "launch_failed",
		providerCode: "provider_launch_failed",
		backend: { id: "dure-local", generation: "generation-1" },
		backendProfileId: "local",
		routeAuthority,
		...overrides,
	};
}

function inheritedTarget(required: DureAgentRuntimeRepairIntentV1) {
	return {
		agentId: required.agentId,
		routeAuthority: required.routeAuthority,
		expectedSourceRevision: required.sourceSelectionRevision,
		interactionProfile: "native_cli" as const,
	};
}

describe("agent runtime replacement target preparation", () => {
	it("resolves an exact parked target regardless of provider diagnostics", () => {
		const first = repairRequired({ providerCode: "codex_launch_failed" });
		const second = repairRequired({ providerCode: "claude_launch_failed" });

		expect(
			resolveAgentRuntimeReplacementTarget(first, inheritedTarget(first)),
		).toEqual(
			resolveAgentRuntimeReplacementTarget(second, inheritedTarget(second)),
		);
		expect(
			resolveAgentRuntimeReplacementTarget(first, inheritedTarget(first)),
		).toMatchObject({
			kind: "ready",
		});
	});

	it("requests preparation for a different credential", () => {
		const required = repairRequired({
			targetInteractionProfile: "structured_protocol",
			targetExecutionProfile: {
				kind: "credential_reference",
				reference_id: "account-a",
				credential_generation: "credential-generation-3",
			},
		});
		const target = {
			...inheritedTarget(required),
			interactionProfile: "structured_protocol" as const,
			execution: {
				kind: "credential" as const,
				referenceId: "account-b",
			},
		};

		expect(resolveAgentRuntimeReplacementTarget(required, target)).toEqual({
			kind: "prepare_execution_profile",
		});

		const preparedProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "credential-generation-9",
		};
		expect(
			resolveAgentRuntimeReplacementTarget(required, {
				...target,
				execution: { ...target.execution, preparedProfile },
			}),
		).toMatchObject({
			kind: "ready",
			target: {
				interactionProfile: "structured_protocol",
				executionProfile: preparedProfile,
			},
		});
	});

	it.each(["credential_stale", "credential_unavailable"] as const)(
		"refreshes the same credential reference for %s",
		(failureKind) => {
			const parkedProfile = {
				kind: "credential_reference" as const,
				reference_id: "account-a",
				credential_generation: "credential-generation-7",
			};
			const required = repairRequired({
				failureKind,
				targetExecutionProfile: parkedProfile,
			});
			const selected = {
				...inheritedTarget(required),
				execution: {
					kind: "credential" as const,
					referenceId: "account-a",
				},
			};

			expect(resolveAgentRuntimeReplacementTarget(required, selected)).toEqual({
				kind: "prepare_execution_profile",
			});
			expect(
				resolveAgentRuntimeReplacementTarget(required, {
					...selected,
					execution: {
						...selected.execution,
						preparedProfile: parkedProfile,
					},
				}),
			).toMatchObject({ kind: "ready" });
			expect(
				resolveAgentRuntimeReplacementTarget(required, {
					...selected,
					execution: {
						...selected.execution,
						preparedProfile: {
							...parkedProfile,
							credential_generation: "credential-generation-8",
						},
					},
				}),
			).toMatchObject({ kind: "ready" });
		},
	);

	it.each(["credential_stale", "credential_unavailable"] as const)(
		"requires credential preparation for an inherited %s execution target",
		(failureKind) => {
			const sourceProfile = {
				kind: "credential_reference" as const,
				reference_id: "account-a",
				credential_generation: "credential-generation-6",
			};
			const parkedProfile = {
				...sourceProfile,
				credential_generation: "credential-generation-7",
			};
			const required = repairRequired({
				failureKind,
				sourceExecutionProfile: sourceProfile,
				targetExecutionProfile: parkedProfile,
			});

			expect(
				resolveAgentRuntimeReplacementTarget(
					required,
					inheritedTarget(required),
				),
			).toEqual({
				kind: "prepare_execution_profile",
			});
		},
	);

	it.each([
		{
			name: "provider default",
			failureKind: "credential_stale" as const,
			source: { kind: "provider_default" as const },
		},
		{
			name: "another credential",
			failureKind: "credential_unavailable" as const,
			source: {
				kind: "credential_reference" as const,
				reference_id: "account-b",
				credential_generation: "credential-generation-4",
			},
		},
	])(
		"reuses $name when another credential target reports $failureKind",
		({ failureKind, source }) => {
			const required = repairRequired({
				failureKind,
				sourceExecutionProfile: source,
				targetExecutionProfile: {
					kind: "credential_reference",
					reference_id: "account-a",
					credential_generation: "credential-generation-7",
				},
			});

			expect(
				resolveAgentRuntimeReplacementTarget(
					required,
					inheritedTarget(required),
				),
			).toMatchObject({
				kind: "ready",
				target: {
					executionProfile: source,
				},
			});
		},
	);

	it("requires preparation when provider default itself is unavailable", () => {
		const required = repairRequired({
			failureKind: "credential_unavailable",
		});

		expect(
			resolveAgentRuntimeReplacementTarget(required, inheritedTarget(required)),
		).toEqual({ kind: "prepare_execution_profile" });
	});

	it("reuses a parked generation for non-credential launch failure", () => {
		const parkedProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-7",
		};
		const required = repairRequired({ targetExecutionProfile: parkedProfile });

		expect(
			resolveAgentRuntimeReplacementTarget(required, {
				...inheritedTarget(required),
				execution: {
					kind: "credential",
					referenceId: "account-a",
				},
			}),
		).toMatchObject({ kind: "ready" });
	});

	it("resolves any requested interaction, execution, or launch target", () => {
		const required = repairRequired();
		const inherited = inheritedTarget(required);
		const executionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-2",
		};
		const changedTargets = [
			{ ...inherited, interactionProfile: "structured_protocol" },
			{
				...inherited,
				execution: { kind: "profile", profile: executionProfile },
			},
			{
				...inherited,
				launchSelection: { model: "gpt-5.6-sol", effort: null },
			},
			{
				...inherited,
				launchSelection: { model: null, effort: "high" },
			},
			{
				...inherited,
				launchSelection: {
					model: null,
					effort: null,
					permissionMode: "skip_permissions",
				},
			},
		] satisfies readonly AgentRuntimeRepairTargetV1[];

		for (const target of changedTargets) {
			expect(
				resolveAgentRuntimeReplacementTarget(required, target),
			).toMatchObject({
				kind: "ready",
			});
		}

		expect(
			resolveAgentRuntimeReplacementTarget(required, {
				...inherited,
				interactionProfile: "structured_protocol",
				execution: { kind: "profile", profile: executionProfile },
				launchSelection: {
					model: "gpt-5.6-sol",
					effort: "high",
					permissionMode: "skip_permissions",
				},
			}),
		).toMatchObject({
			kind: "ready",
			target: {
				interactionProfile: "structured_protocol",
				executionProfile: executionProfile,
				launchSelection: {
					model: "gpt-5.6-sol",
					effort: "high",
					permissionMode: "skip_permissions",
				},
			},
		});
	});

	it("rejects only mismatched action identity, route, or source revision", () => {
		const required = repairRequired();
		const target = inheritedTarget(required);
		const otherRoute = testDureBackendRouteAuthority(
			"dure-local",
			"generation-2",
		);

		expect(
			resolveAgentRuntimeReplacementTarget(required, {
				...target,
				agentId: "agent-2",
			}),
		).toBeUndefined();
		expect(
			resolveAgentRuntimeReplacementTarget(required, {
				...target,
				routeAuthority: otherRoute,
			}),
		).toBeUndefined();
		expect(
			resolveAgentRuntimeReplacementTarget(required, {
				...target,
				expectedSourceRevision: 9,
			}),
		).toBeUndefined();
	});

	it("accepts only a stable result for the planned target", () => {
		const required = repairRequired();
		const plan = resolveAgentRuntimeReplacementTarget(
			required,
			inheritedTarget(required),
		);
		if (!plan || plan.kind === "prepare_execution_profile") {
			throw new Error("expected an executable repair plan");
		}
		const result = {
			agentId: required.agentId,
			selectionRevision: 3,
			providerId: "codex",
			executionProfile: required.targetExecutionProfile,
			providerConversationRef: "conversation-1",
			launchSelection: required.targetLaunchSelection,
			interactionProfile: "native_cli",
			sessionId: "session-1",
			workspaceId: "workspace-1",
			launchIdempotencyKey: "launch-1",
			stopFence: {
				runnerPrincipal: "runner-1",
				runnerInstance: "instance-1",
				channelEpoch: "1",
				hostInstanceId: "host-1",
				terminalEpoch: "terminal-1",
			},
			backend: required.backend,
			backendProfileId: required.backendProfileId,
			routeAuthority: required.routeAuthority,
		} satisfies DureAgentRuntimeTransitionResultV1;

		expect(agentRuntimeReplacementResultMatches(required, plan, result)).toBe(
			true,
		);
		expect(
			agentRuntimeReplacementResultMatches(required, plan, {
				...result,
				launchSelection: { ...result.launchSelection, effort: "high" },
			}),
		).toBe(false);
	});
});
