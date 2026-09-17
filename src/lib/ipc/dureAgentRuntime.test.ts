import { describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import {
	createDureAgentRuntimeClient,
	DureAgentRuntimeSourceActiveError,
} from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import {
	agentRuntimeBackendEnvelope as envelope,
	agentRuntimeProjectionContext as projectionContext,
	nativeRuntimeReceipt,
} from "@/test/dureAgentRuntimeFixtures";

const replacementExecutionProfile = {
	kind: "credential_reference" as const,
	reference_id: "account-b",
	credential_generation: "credential-b-9",
};

function transitionInspectionWireFields(source: ReturnType<typeof envelope>) {
	const launchSelection = { permissionMode: "default" as const };
	return {
		sourceSelectionRevision: source.result.receipt.selectionRevision,
		sourceInteractionProfile:
			source.result.receipt.authority.interactionProfile,
		sourceExecutionProfile: source.result.receipt.executionProfile,
		sourceLaunchSelection: launchSelection,
		targetExecutionProfile: source.result.receipt.executionProfile,
		targetLaunchSelection: launchSelection,
	};
}

function parsedTransitionInspectionFields(source: ReturnType<typeof envelope>) {
	const launchSelection = {
		model: null,
		effort: null,
		permissionMode: "default" as const,
	};
	return {
		sourceSelectionRevision: source.result.receipt.selectionRevision,
		sourceInteractionProfile:
			source.result.receipt.authority.interactionProfile,
		sourceExecutionProfile: source.result.receipt.executionProfile,
		sourceLaunchSelection: launchSelection,
		targetExecutionProfile: source.result.receipt.executionProfile,
		targetLaunchSelection: launchSelection,
	};
}

describe("Dure Agent runtime client", () => {
	it("reads runtime and canonical workspace identity in one selected snapshot", async () => {
		const source = envelope();
		const context = projectionContext();
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: { ...source.result, state: "stable", projectionContext: context },
		});
		const result = await createDureAgentRuntimeClient({ invokeCommand }).inspect("agent-1");
		expect(result).toMatchObject({ state: "stable", projectionContext: context });
		expect(invokeCommand).toHaveBeenCalledOnce();
		expect(invokeCommand.mock.calls[0][1].operation).toBe("agent_runtime.projection.inspect");
	});

	it("lets the backend select the preserve source revision as the CLI does", async () => {
		const response = envelope();
		const invokeCommand = vi.fn().mockResolvedValue(response);
		await expect(
			createDureAgentRuntimeClient({ invokeCommand }).transition({
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				routeAuthority: response.routeAuthority,
			}),
		).resolves.toMatchObject({ interactionProfile: "structured_protocol" });
		expect(invokeCommand).toHaveBeenCalledOnce();
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: response.routeAuthority },
			operation: "agent_runtime.transition",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
			},
		});
	});

	it("parses the selected backend profile once when the client is created", () => {
		expect(() =>
			createDureAgentRuntimeClient({ profileId: "SSH-Team" }),
		).toThrow();
	});

	it("accepts an unclaimed credential generation only for a Host-proven Native selection", async () => {
		const source = envelope();
		const unclaimed = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: null,
		};
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce({
				...source,
				result: {
					state: "stable",
					projectionContext: projectionContext(),
					schemaVersion: 1,
					receipt: nativeRuntimeReceipt(unclaimed),
				},
			})
			.mockResolvedValueOnce({
				...source,
				result: {
					state: "stable",
					projectionContext: projectionContext(),
					schemaVersion: 1,
					receipt: nativeRuntimeReceipt(
						unclaimed,
						1,
						"runtime-native-launch-1",
					),
				},
			})
			.mockResolvedValueOnce({
				...source,
				result: {
					state: "stable",
					projectionContext: projectionContext(),
					schemaVersion: 1,
					receipt: nativeRuntimeReceipt(unclaimed, 2),
				},
			});
		const client = createDureAgentRuntimeClient({ invokeCommand });

		await expect(client.inspect("agent-1")).resolves.toMatchObject({
			state: "stable",
			projectionContext: projectionContext(),
			interactionProfile: "native_cli",
			selectionRevision: 1,
			executionProfile: unclaimed,
		});
		await expect(client.inspect("agent-1")).resolves.toMatchObject({
			state: "stable",
			projectionContext: projectionContext(),
			interactionProfile: "native_cli",
			launchIdempotencyKey: "runtime-native-launch-1",
			executionProfile: unclaimed,
		});
		await expect(client.inspect("agent-1")).rejects.toMatchObject({
			code: "agent_runtime_transition_response_invalid",
		});
	});

	it("rejects an unclaimed credential generation on Structured authority", async () => {
		const source = envelope();
		const unclaimed = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: null,
		};
		const receipt = {
			...source.result.receipt,
			executionProfile: unclaimed,
			authority: {
				...source.result.receipt.authority,
				binding: {
					...source.result.receipt.authority.binding,
					executionProfile: unclaimed,
				},
			},
		};
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: { state: "stable", schemaVersion: 1, receipt, projectionContext: projectionContext() },
		});

		await expect(
			createDureAgentRuntimeClient({ invokeCommand }).inspect("agent-1"),
		).rejects.toMatchObject({
			code: "agent_runtime_transition_response_invalid",
		});
	});

	it("rejects an incomplete snapshot without retrying the legacy endpoint", async () => {
		const source = envelope();
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: { ...source.result, state: "stable" },
		});
		await expect(createDureAgentRuntimeClient({ invokeCommand }).inspect("agent-1"))
			.rejects.toMatchObject({ code: "agent_runtime_transition_response_invalid" });
		expect(invokeCommand).toHaveBeenCalledOnce();
	});

	it("parses canonical context only from projection inspect", async () => {
		const source = envelope();
		const context = projectionContext();
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: {
				state: "stable",
				schemaVersion: 1,
				projectionContext: context,
				receipt: source.result.receipt,
			},
		});

		const result = await createDureAgentRuntimeClient({
			invokeCommand,
		}).inspectExact("agent-1", source.routeAuthority);

		expect(result).toMatchObject({
			state: "stable",
			projectionContext: context,
		});
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.projection.inspect",
			body: { schemaVersion: 1, agentId: "agent-1" },
		});
	});

	it("parses one authoritative source snapshot for a stopped runtime", async () => {
		const envelopeSource = envelope();
		const context = projectionContext();
		const source = {
			selectionRevision: 7,
			interactionProfile: "native_cli",
			launchSelection: {
				model: "gpt-5.6-sol",
				permissionMode: "default",
			},
		};
		const invokeCommand = vi.fn().mockResolvedValue({
			...envelopeSource,
			result: {
				state: "closed",
				schemaVersion: 1,
				agentId: "agent-1",
				operationId: "runtime-close-1",
				stage: "stopped",
				source,
				projectionContext: context,
			},
		});

		await expect(
			createDureAgentRuntimeClient({
				invokeCommand,
			}).inspectExact("agent-1", envelopeSource.routeAuthority),
		).resolves.toMatchObject({
			state: "closed",
			stage: "stopped",
			source: {
				selectionRevision: 7,
				interactionProfile: "native_cli",
				launchSelection: {
					model: "gpt-5.6-sol",
					effort: null,
					permissionMode: "default",
				},
			},
			projectionContext: context,
		});
	});

	it("rejects incomplete or cross-domain Stable projection identity", async () => {
		const source = envelope();
		const context = projectionContext();
		for (const projectionContext of [
			{ ...context, identity: { kind: "unknown" } },
			{
				...context,
				identity: {
					kind: "checkpoint_bootstrap",
					runtimeWorkspaceId: "",
				},
			},
			{
				...context,
				agent: { ...context.agent, providerId: "codex" },
			},
			{
				...context,
				workspace: { ...context.workspace, workspaceId: "workspace-other" },
			},
			{
				...context,
				project: { ...context.project, projectId: "project-other" },
			},
		]) {
			const invokeCommand = vi.fn().mockResolvedValue({
				...source,
				result: {
					state: "stable",
					schemaVersion: 1,
					projectionContext,
					receipt: source.result.receipt,
				},
			});
			await expect(
				createDureAgentRuntimeClient({
					invokeCommand,
				}).inspectExact("agent-1", source.routeAuthority),
			).rejects.toMatchObject({
				code: "agent_runtime_transition_response_invalid",
			});
		}
	});

	it("carries canonical context on projection Transitioning and RepairRequired observations", async () => {
		const source = envelope();
		const context = projectionContext();
		const transitioning = {
			state: "transitioning",
			schemaVersion: 1,
			projectionContext: context,
			agentId: "agent-1",
			operationId: "runtime-transition-1",
			stage: "source_stopped",
			journalRevision: 3,
			targetInteractionProfile: "structured_protocol",
			targetExecutionProfile: source.result.receipt.executionProfile,
		};
		const repairRequired = {
			...transitioning,
			stage: "repair_required",
			targetFailure: {
				kind: "credential_stale",
				providerCode: "claude_credential_generation_stale",
			},
		};
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce({ ...source, result: transitioning })
			.mockResolvedValueOnce({ ...source, result: repairRequired });
		const client = createDureAgentRuntimeClient({ invokeCommand });

		await expect(
			client.inspectExact("agent-1", source.routeAuthority),
		).resolves.toMatchObject({
			state: "transitioning",
			projectionContext: context,
		});
		await expect(
			client.inspectExact("agent-1", source.routeAuthority),
		).resolves.toMatchObject({
			state: "repair_required",
			projectionContext: context,
			failureKind: "credential_stale",
		});
	});

	it("projects an absent launch selection as provider defaults", async () => {
		const source = envelope();
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: {
				state: "stable",
				projectionContext: projectionContext(),
				schemaVersion: 1,
				receipt: source.result.receipt,
			},
		});
		const result = await createDureAgentRuntimeClient({
			invokeCommand,
		}).inspect("agent-1");
		expect(result).toMatchObject({
			state: "stable",
			projectionContext: projectionContext(),
			launchSelection: { model: null, effort: null },
		});
	});

	it("projects a committed launch selection from the receipt", async () => {
		const source = envelope();
		const receipt = {
			...source.result.receipt,
			model: "gpt-5.6-sol",
			effort: "xhigh",
		};
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: {
				state: "stable",
				projectionContext: projectionContext(),
				schemaVersion: 1,
				receipt,
			},
		});
		const result = await createDureAgentRuntimeClient({
			invokeCommand,
		}).inspect("agent-1");
		expect(result).toMatchObject({
			launchSelection: { model: "gpt-5.6-sol", effort: "xhigh" },
		});

		// A model without an effort is a legal partial presence.
		const partial = { ...source.result.receipt, model: "opus" };
		invokeCommand.mockResolvedValue({
			...source,
			result: {
				state: "stable",
				projectionContext: projectionContext(),
				schemaVersion: 1,
				receipt: partial,
			},
		});
		const partialResult = await createDureAgentRuntimeClient({
			invokeCommand,
		}).inspect("agent-1");
		expect(partialResult).toMatchObject({
			launchSelection: { model: "opus", effort: null },
		});
	});

	it("rejects malformed launch-selection values", async () => {
		const source = envelope();
		for (const receipt of [
			{ ...source.result.receipt, model: 123 },
			{ ...source.result.receipt, effort: "" },
			{ ...source.result.receipt, model: null },
		]) {
			const invokeCommand = vi.fn().mockResolvedValue({
				...source,
				result: {
					state: "stable",
					projectionContext: projectionContext(),
					schemaVersion: 1,
					receipt,
				},
			});
			await expect(
				createDureAgentRuntimeClient({ invokeCommand }).inspect("agent-1"),
			).rejects.toMatchObject({
				code: "agent_runtime_transition_response_invalid",
			});
		}
	});

	it("serializes a selection-only transition body omitting null values", async () => {
		const source = envelope();
		const receipt = { ...source.result.receipt, model: "gpt-5.6-terra" };
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: { schemaVersion: 1, receipt },
		});
		await createDureAgentRuntimeClient({ invokeCommand }).transition({
			agentId: "agent-1",
			targetInteractionProfile: "structured_protocol",
			expectedSourceRevision: 1,
			targetLaunchSelection: { model: "gpt-5.6-terra", effort: null },
			routeAuthority: source.routeAuthority,
		});
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.transition",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				expectedSourceRevision: 1,
				targetLaunchSelection: { model: "gpt-5.6-terra" },
			},
		});
	});

	it("rejects invalid launch-selection tokens before any request", async () => {
		const invokeCommand = vi.fn();
		const routeAuthority = testDureBackendRouteAuthority(
			"dure-local",
			"backend-1",
		);
		await expect(
			createDureAgentRuntimeClient({ invokeCommand }).transition({
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				expectedSourceRevision: 1,
				targetLaunchSelection: { model: "bad token", effort: null },
				routeAuthority,
			}),
		).rejects.toMatchObject({
			code: "agent_runtime_transition_response_invalid",
		});
		expect(invokeCommand).not.toHaveBeenCalled();
	});

	it("rejects an invalid expected source revision before any request", async () => {
		const invokeCommand = vi.fn();
		const routeAuthority = testDureBackendRouteAuthority(
			"dure-local",
			"backend-1",
		);
		await expect(
			createDureAgentRuntimeClient({ invokeCommand }).transition({
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				expectedSourceRevision: 0,
				routeAuthority,
			}),
		).rejects.toMatchObject({
			code: "agent_runtime_transition_response_invalid",
		});
		expect(invokeCommand).not.toHaveBeenCalled();
	});

	it("inspects the stable backend authority without starting a provider surface", async () => {
		const source = envelope();
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: {
				state: "stable",
				projectionContext: projectionContext(),
				schemaVersion: 1,
				receipt: source.result.receipt,
			},
		});

		const result = await createDureAgentRuntimeClient({
			invokeCommand,
		}).inspect("agent-1");

		expect(result).toMatchObject({
			state: "stable",
			projectionContext: projectionContext(),
			interactionProfile: "structured_protocol",
			interactionSessionId: "interaction-1",
			routeAuthority: source.routeAuthority,
		});
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "selected", profileId: "local" },
			operation: "agent_runtime.projection.inspect",
			body: { schemaVersion: 1, agentId: "agent-1" },
		});
	});

	it("inspects one exact backend route for successor replay classification", async () => {
		const source = envelope();
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: {
				state: "stable",
				projectionContext: projectionContext(),
				schemaVersion: 1,
				receipt: source.result.receipt,
			},
		});

		await createDureAgentRuntimeClient({ invokeCommand }).inspectExact(
			"agent-1",
			source.routeAuthority,
		);

		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.projection.inspect",
			body: { schemaVersion: 1, agentId: "agent-1" },
		});
	});

	it("passes one observed route authority unchanged to a runtime mutation", async () => {
		const source = envelope();
		const invokeCommand = vi.fn().mockResolvedValue(source);
		const client = createDureAgentRuntimeClient({ invokeCommand });

		await client.transition({
			agentId: "agent-1",
			targetInteractionProfile: "structured_protocol",
			expectedSourceRevision: 1,
			sourceStopPolicy: "preserve",
			routeAuthority: source.routeAuthority,
		});

		expect(invokeCommand).toHaveBeenCalledWith(
			"dure_backend_request",
			expect.objectContaining({
				route: { kind: "exact", authority: source.routeAuthority },
				operation: "agent_runtime.transition",
			}),
		);
	});

	it("refuses a route from another profile before any runtime mutation", async () => {
		const invokeCommand = vi.fn();
		const client = createDureAgentRuntimeClient({
			profileId: "local",
			invokeCommand,
		});

		await expect(
			client.transition({
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				expectedSourceRevision: 1,
				routeAuthority: testDureBackendRouteAuthority(
					"dure-remote",
					"backend-1",
					"ssh-profile-1",
				),
			}),
		).rejects.toMatchObject({
			code: "agent_runtime_transition_response_invalid",
			failure: { kind: "contract" },
		});
		expect(invokeCommand).not.toHaveBeenCalled();
	});

	it("reports an in-flight transition instead of projecting a stale surface", async () => {
		const source = envelope();
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: {
				state: "transitioning",
				projectionContext: projectionContext(),
				schemaVersion: 1,
				agentId: "agent-1",
				operationId: "runtime-transition-1",
				stage: "source_stopped",
				journalRevision: 2,
				targetInteractionProfile: "structured_protocol",
				targetExecutionProfile: source.result.receipt.executionProfile,
			},
		});

		await expect(
			createDureAgentRuntimeClient({ invokeCommand }).inspect("agent-1"),
		).resolves.toMatchObject({
			state: "transitioning",
			projectionContext: projectionContext(),
			stage: "source_stopped",
			targetInteractionProfile: "structured_protocol",
		});
	});

	it("submits an admitted target through the semantic transition operation", async () => {
		const source = envelope();
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce({
				...source,
				result: {
					state: "transitioning",
					projectionContext: projectionContext(),
					schemaVersion: 1,
					agentId: "agent-1",
					operationId: "runtime-transition-1",
					stage: "admitted",
					journalRevision: 1,
					targetInteractionProfile: "native_cli",
					targetExecutionProfile: source.result.receipt.executionProfile,
				},
			})
			.mockResolvedValueOnce({
				...source,
				result: {
					schemaVersion: 1,
					receipt: nativeRuntimeReceipt(
						source.result.receipt.executionProfile,
						2,
						"runtime-native-repair-1",
					),
				},
			});
		const client = createDureAgentRuntimeClient({ invokeCommand });
		const inspected = await client.inspect("agent-1");
		if (inspected.state !== "transitioning" || inspected.stage !== "admitted") {
			throw new Error("unreachable");
		}
		const admitted = { ...inspected, stage: inspected.stage };

		await expect(client.transition({
			agentId: admitted.agentId,
			targetInteractionProfile: admitted.targetInteractionProfile,
			routeAuthority: admitted.routeAuthority,
		})).resolves.toMatchObject({
			interactionProfile: "native_cli",
			selectionRevision: 2,
		});
		expect(invokeCommand).toHaveBeenNthCalledWith(2, "dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.transition",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				targetInteractionProfile: "native_cli",
			},
		});
		expect(invokeCommand).toHaveBeenCalledTimes(2);
	});

	it("reads admitted action inputs separately from the complete identity snapshot", async () => {
		const source = envelope();
		const identity = {
			schemaVersion: 1,
			agentId: "agent-1",
			operationId: "runtime-transition-1",
			journalRevision: 1,
			targetInteractionProfile: "structured_protocol",
			targetExecutionProfile: source.result.receipt.executionProfile,
		};
		const invokeCommand = vi.fn()
			.mockResolvedValueOnce({ ...source, result: { ...identity, state: "transitioning", stage: "admitted", projectionContext: projectionContext() } })
			.mockResolvedValueOnce({ ...source, result: { ...identity, state: "admitted", ...transitionInspectionWireFields(source) } });
		const client = createDureAgentRuntimeClient({ invokeCommand });
		const observed = await client.inspect("agent-1");
		if (observed.state !== "transitioning" || observed.stage !== "admitted") throw new Error("unreachable");
		const intent = await client.inspectTransitionIntent({ ...observed, stage: "admitted" });
		expect(intent).toMatchObject({ ...observed, ...parsedTransitionInspectionFields(source) });
		expect(invokeCommand).toHaveBeenNthCalledWith(2, "dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.repair_intent.inspect.v1",
			body: { schemaVersion: 1, agentId: "agent-1", operationId: "runtime-transition-1", expectedJournalRevision: 1 },
		});
	});

	it("projects a permanent target failure as an exact repair handle", async () => {
		const source = envelope();
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce({
				...source,
				result: {
					state: "transitioning",
					projectionContext: projectionContext(),
					schemaVersion: 1,
					agentId: "agent-1",
					operationId: "runtime-transition-1",
					stage: "repair_required",
					journalRevision: 3,
					targetInteractionProfile: "structured_protocol",
					targetExecutionProfile: source.result.receipt.executionProfile,
					targetFailure: {
						kind: "credential_stale",
						providerCode: "claude_credential_generation_stale",
					},
				},
			})
			.mockResolvedValueOnce({
				...source,
				result: {
					state: "repair_required",
					schemaVersion: 1,
					agentId: "agent-1",
					operationId: "runtime-transition-1",
					journalRevision: 3,
					...transitionInspectionWireFields(source),
					targetInteractionProfile: "structured_protocol",
					targetFailure: {
						kind: "credential_stale",
						providerCode: "claude_credential_generation_stale",
					},
				},
			})
			.mockResolvedValueOnce(source);
		const client = createDureAgentRuntimeClient({ invokeCommand });

		const required = await client.inspect("agent-1");
		expect(required).toEqual({
			state: "repair_required",
			projectionContext: projectionContext(),
			agentId: "agent-1",
			operationId: "runtime-transition-1",
			journalRevision: 3,
			targetInteractionProfile: "structured_protocol",
			targetExecutionProfile: source.result.receipt.executionProfile,
			failureKind: "credential_stale",
			providerCode: "claude_credential_generation_stale",
			backend: { id: "dure-local", generation: "backend-1" },
			backendProfileId: "local",
			routeAuthority: source.routeAuthority,
		});
		if (required.state !== "repair_required") throw new Error("unreachable");
		const intent = await client.inspectTransitionIntent(required);
		expect(intent).toMatchObject({
			...parsedTransitionInspectionFields(source),
			providerCode: "claude_credential_generation_stale",
		});

		await client.transition({
			agentId: required.agentId,
			targetInteractionProfile: required.targetInteractionProfile,
			routeAuthority: required.routeAuthority,
		});

		expect(invokeCommand).toHaveBeenNthCalledWith(2, "dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.repair_intent.inspect.v1",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				operationId: "runtime-transition-1",
				expectedJournalRevision: 3,
			},
		});
		expect(invokeCommand).toHaveBeenNthCalledWith(3, "dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.transition",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
			},
		});
	});

	it("submits a corrected target without choosing a repair algorithm", async () => {
		const source = envelope();
		const required = {
			state: "repair_required" as const,
			agentId: "agent-1",
			operationId: "runtime-transition-1",
			journalRevision: 3,
			targetInteractionProfile: "structured_protocol" as const,
			targetExecutionProfile: source.result.receipt.executionProfile,
			failureKind: "credential_stale" as const,
			providerCode: "claude_credential_generation_stale",
			backend: { id: "dure-local", generation: "backend-1" },
			backendProfileId: "local",
			routeAuthority: source.routeAuthority,
		};
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: {
				...source.result,
				receipt: {
					...source.result.receipt,
					executionProfile: replacementExecutionProfile,
					authority: {
						...source.result.receipt.authority,
						binding: {
							...source.result.receipt.authority.binding,
							executionProfile: replacementExecutionProfile,
						},
					},
				},
			},
		});

		await createDureAgentRuntimeClient({ invokeCommand }).transition({
			agentId: required.agentId,
			routeAuthority: required.routeAuthority,
			targetInteractionProfile: "structured_protocol",
			targetExecutionProfile: replacementExecutionProfile,
		});

		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.transition",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				targetExecutionProfile: replacementExecutionProfile,
			},
		});
	});

	it.each(["stop", "remove"] as const)(
		"routes %s to its distinct backend lifetime operation",
		async (operation) => {
			const routeAuthority = testDureBackendRouteAuthority(
				"dure-local",
				"backend-1",
			);
			const invokeCommand = vi.fn().mockResolvedValue({
				schemaVersion: 1,
				backendId: "dure-local",
				backendGeneration: "backend-1",
				routeAuthority,
				result: { schemaVersion: 1, stopped: true },
			});

			await createDureAgentRuntimeClient({ invokeCommand })[operation](
				"agent-1",
				routeAuthority,
			);

			expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
				route: { kind: "exact", authority: routeAuthority },
				operation: `agent_runtime.${operation}`,
				body: {
					schemaVersion: 1,
					agentId: "agent-1",
				},
			});
		},
	);

	it("requests one backend-owned profile replacement and returns its exact binding", async () => {
		const source = envelope();
		const invokeCommand = vi.fn().mockResolvedValue(source);
		const result = await createDureAgentRuntimeClient({
			invokeCommand,
		}).transition({
			agentId: "agent-1",
			targetInteractionProfile: "structured_protocol",
			expectedSourceRevision: 1,
			routeAuthority: source.routeAuthority,
		});

		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.transition",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				expectedSourceRevision: 1,
			},
		});
		expect(result).toMatchObject({
			backend: { id: "dure-local", generation: "backend-1" },
			backendProfileId: "local",
			agentId: "agent-1",
			providerId: "claude",
			interactionProfile: "structured_protocol",
			interactionSessionId: "interaction-1",
			providerConversationRef: "conversation-1",
		});
	});

	it("serializes explicit discard authority without changing the safe default", async () => {
		const source = envelope();
		const invokeCommand = vi.fn().mockResolvedValue(source);

		await createDureAgentRuntimeClient({ invokeCommand }).transition({
			agentId: "agent-1",
			targetInteractionProfile: "structured_protocol",
			expectedSourceRevision: 1,
			sourceStopPolicy: "discard",
			routeAuthority: source.routeAuthority,
		});

		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.transition",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				expectedSourceRevision: 1,
				sourceStopPolicy: "discard",
			},
		});
	});

	it.each([
		{
			code: "agent_runtime_source_busy",
			message: "source busy",
			details: { disposition: "terminal" },
		},
		{
			code: "agent_runtime_source_retained",
			message: "source retained",
			details: { disposition: "terminal" },
		},
	])(
		"normalizes source ownership failures into one typed condition",
		async (failure) => {
			const routeAuthority = testDureBackendRouteAuthority(
				"dure-local",
				"backend-1",
			);
			const client = createDureAgentRuntimeClient({
				invokeCommand: vi.fn().mockRejectedValue(failure),
			});

			const error = await client
				.transition({
					agentId: "agent-1",
					targetInteractionProfile: "structured_protocol",
					expectedSourceRevision: 1,
					routeAuthority,
				})
				.catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(DureAgentRuntimeSourceActiveError);
			expect(error).toMatchObject({ condition: "source_active" });
		},
	);

	it("presents structured runtime unavailability without exposing the protocol code", async () => {
		const source = envelope();
		const client = createDureAgentRuntimeClient({
			invokeCommand: vi.fn().mockRejectedValue({
				code: "agent_runtime_structured_profile_unavailable",
				message: "agent_runtime_structured_profile_unavailable",
				details: { disposition: "retry_same" },
			}),
		});

		const error = await client
			.transition({
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				expectedSourceRevision: 1,
				routeAuthority: source.routeAuthority,
			})
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(t("agents.runtime.chatUnavailable"));
		expect((error as Error).message).not.toContain(
			"agent_runtime_structured_profile_unavailable",
		);
	});

	it("presents the structured runtime's bounded refusal detail", async () => {
		const source = envelope();
		const detail = "codex 0.152.2 not reviewed: schema digest fixture";
		const client = createDureAgentRuntimeClient({
			invokeCommand: vi.fn().mockRejectedValue({
				code: "agent_runtime_structured_profile_unavailable",
				message: "agent_runtime_structured_profile_unavailable",
				details: { disposition: "retry_same", detail },
			}),
		});

		const error = await client
			.transition({
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				expectedSourceRevision: 1,
				routeAuthority: source.routeAuthority,
			})
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(DureBackendRequestError);
		expect((error as Error).message).toBe(detail);
	});

	it("rejects a receipt that does not belong to the requested Agent", async () => {
		const routeAuthority = testDureBackendRouteAuthority(
			"dure-local",
			"backend-1",
		);
		const client = createDureAgentRuntimeClient({
			invokeCommand: vi
				.fn()
				.mockResolvedValue(envelope({ agentId: "agent-other" })),
		});
		await expect(
			client.transition({
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				expectedSourceRevision: 1,
				routeAuthority,
			}),
		).rejects.toMatchObject({
			code: "agent_runtime_transition_response_invalid",
			failure: { kind: "contract" },
		});
	});

	it("requests one structured runtime replacement for an exact credential generation", async () => {
		const original = envelope();
		const invokeCommand = vi.fn().mockResolvedValue({
			...original,
			result: {
				...original.result,
				receipt: {
					...original.result.receipt,
					executionProfile: replacementExecutionProfile,
					authority: {
						...original.result.receipt.authority,
						binding: {
							...original.result.receipt.authority.binding,
							executionProfile: replacementExecutionProfile,
						},
					},
				},
			},
		});
		const client = createDureAgentRuntimeClient({ invokeCommand });

		const result = await client.transition({
			agentId: "agent-1",
			targetInteractionProfile: "structured_protocol",
			expectedSourceRevision: 1,
			targetExecutionProfile: replacementExecutionProfile,
			routeAuthority: original.routeAuthority,
		});

		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: original.routeAuthority },
			operation: "agent_runtime.transition",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				expectedSourceRevision: 1,
				targetExecutionProfile: replacementExecutionProfile,
			},
		});
		expect(result.executionProfile).toEqual(replacementExecutionProfile);
	});

	it("returns the exact managed Hmux authority for a native target", async () => {
		const source = envelope();
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: {
				schemaVersion: 1,
				receipt: {
					schemaVersion: 1,
					agentId: "agent-1",
					selectionRevision: 2,
					providerId: "claude",
					executionProfile: source.result.receipt.executionProfile,
					permissionMode: "default",
					providerConversationRef: "conversation-1",
					launchIdempotencyKey: "runtime-native-launch-1",
					authority: {
						interactionProfile: "native_cli",
						authority: {
							schemaVersion: 1,
							binding: {
								agentId: "agent-1",
								runtimeKindId: "runtime.hmux",
								sessionId: "runtime-native-1",
								providerConversationId: "conversation-1",
								credentialReferenceId: "account-a",
								bindingGeneration: 2,
								boundAtMs: 2,
							},
							runtimeWorkspaceId: "workspace-1",
							runnerPrincipal: "runner-1",
							runnerInstance: "instance-1",
							channelEpoch: "2",
							hostInstanceId: "host-1",
							terminalEpoch: "terminal-2",
							updatedAtMs: 2,
						},
					},
				},
			},
		});

		const result = await createDureAgentRuntimeClient({
			invokeCommand,
		}).transition({
			agentId: "agent-1",
			targetInteractionProfile: "native_cli",
			expectedSourceRevision: 1,
			routeAuthority: source.routeAuthority,
		});

		expect(result).toMatchObject({
			interactionProfile: "native_cli",
			sessionId: "runtime-native-1",
			workspaceId: "workspace-1",
			launchIdempotencyKey: "runtime-native-launch-1",
			stopFence: { terminalEpoch: "terminal-2" },
		});
		expect(invokeCommand).toHaveBeenCalledWith(
			"dure_backend_request",
			expect.objectContaining({
				body: expect.objectContaining({
					targetInteractionProfile: "native_cli",
				}),
			}),
		);
	});

	it("commits a native rehost without echoing source profile or permission hints", async () => {
		const source = envelope();
		const targetExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: "credential-profile",
			credential_generation: "generation-2",
		};
		const target = {
			sessionId: "runtime-native-2",
			workspaceId: "workspace-1",
			runnerPrincipal: "runner-2",
			runnerInstance: "instance-2",
			channelEpoch: "3",
			hostInstanceId: "host-2",
			terminalEpoch: "terminal-3",
		};
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: {
				schemaVersion: 1,
				receipt: {
					schemaVersion: 1,
					agentId: "agent-1",
					selectionRevision: 2,
					providerId: "claude",
					executionProfile: targetExecutionProfile,
					permissionMode: "default",
					providerConversationRef: null,
					launchIdempotencyKey: "runtime-native-launch-2",
					authority: {
						interactionProfile: "native_cli",
						authority: {
							schemaVersion: 1,
							binding: {
								agentId: "agent-1",
								runtimeKindId: "runtime.hmux",
								sessionId: target.sessionId,
								providerConversationId: null,
								credentialReferenceId: "credential-profile",
								bindingGeneration: 2,
								boundAtMs: 2,
							},
							runtimeWorkspaceId: target.workspaceId,
							runnerPrincipal: target.runnerPrincipal,
							runnerInstance: target.runnerInstance,
							channelEpoch: target.channelEpoch,
							hostInstanceId: target.hostInstanceId,
							terminalEpoch: target.terminalEpoch,
							updatedAtMs: 2,
						},
					},
				},
			},
		});
		const sourceGeneration = {
			sessionId: "runtime-native-1",
			workspaceId: "workspace-1",
			runnerPrincipal: "runner-1",
			runnerInstance: "instance-1",
			channelEpoch: "2",
			hostInstanceId: "host-1",
			terminalEpoch: "terminal-2",
		};

		const result = await createDureAgentRuntimeClient({
			invokeCommand,
		}).reconcileNativeRehost({
			agentId: "agent-1",
			operationId: "rehost-operation-1",
			providerId: "claude",
			targetCredential: {
				kind: "credential_reference",
				referenceId: "credential-profile",
			},
			source: sourceGeneration,
			target,
			routeAuthority: source.routeAuthority,
		});

		expect(result.providerConversationRef).toBeNull();
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.native_rehost.reconcile",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				operationId: "rehost-operation-1",
				providerId: "claude",
				targetCredential: {
					kind: "credential_reference",
					referenceId: "credential-profile",
				},
				source: sourceGeneration,
				target,
			},
		});
	});

	it("publishes an already-launched native Resume target without source authority", async () => {
		const source = envelope();
		const target = {
			sessionId: "runtime-native-resume-1",
			workspaceId: "workspace-1",
			runnerPrincipal: "runner-resume",
			runnerInstance: "instance-resume",
			channelEpoch: "4",
			hostInstanceId: "host-resume",
			terminalEpoch: "terminal-resume",
		};
		const executionProfile = {
			kind: "credential_reference" as const,
			reference_id: "credential-profile",
			credential_generation: null,
		};
		const invokeCommand = vi.fn().mockResolvedValue({
			...source,
			result: {
				schemaVersion: 1,
				receipt: {
					...nativeRuntimeReceipt(executionProfile, 2, "resume-create-1"),
					permissionMode: "skip_permissions",
					authority: {
						interactionProfile: "native_cli",
						authority: {
							schemaVersion: 1,
							binding: {
								agentId: "agent-1",
								runtimeKindId: "runtime.hmux",
								sessionId: target.sessionId,
								providerConversationId: "conversation-1",
								credentialReferenceId: "credential-profile",
								bindingGeneration: 2,
								boundAtMs: 2,
							},
							runtimeWorkspaceId: target.workspaceId,
							runnerPrincipal: target.runnerPrincipal,
							runnerInstance: target.runnerInstance,
							channelEpoch: target.channelEpoch,
							hostInstanceId: target.hostInstanceId,
							terminalEpoch: target.terminalEpoch,
							updatedAtMs: 2,
						},
					},
				},
			},
		});

		const result = await createDureAgentRuntimeClient({
			invokeCommand,
		}).publishNativeResume({
			agentId: "agent-1",
			operationId: "resume-operation-1",
			providerId: "claude",
			targetCredential: {
				kind: "credential_reference",
				referenceId: "credential-profile",
			},
			providerConversationRef: "conversation-1",
			permissionMode: "skip_permissions",
			launchIdempotencyKey: "resume-create-1",
			target,
			routeAuthority: source.routeAuthority,
		});

		expect(result).toMatchObject({
			sessionId: target.sessionId,
			workspaceId: target.workspaceId,
			launchIdempotencyKey: "resume-create-1",
			launchSelection: { permissionMode: "skip_permissions" },
		});
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: source.routeAuthority },
			operation: "agent_runtime.native_resume.publish",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				operationId: "resume-operation-1",
				providerId: "claude",
				targetCredential: {
					kind: "credential_reference",
					referenceId: "credential-profile",
				},
				providerConversationRef: "conversation-1",
				permissionMode: "skip_permissions",
				launchIdempotencyKey: "resume-create-1",
				target,
			},
		});
		expect(invokeCommand.mock.calls[0][1].body).not.toHaveProperty("source");
	});

	it("rejects a provider launch reference outside the credential reference domain before invoke", async () => {
		const source = envelope();
		const invokeCommand = vi.fn();

		await expect(
			createDureAgentRuntimeClient({ invokeCommand }).reconcileNativeRehost({
				agentId: "agent-1",
				operationId: "rehost-operation-1",
				providerId: "claude",
				targetCredential: {
					kind: "credential_reference",
					referenceId: "credential+profile",
				},
				source: {
					sessionId: "runtime-native-1",
					workspaceId: "workspace-1",
					runnerPrincipal: "runner-1",
					runnerInstance: "instance-1",
					channelEpoch: "2",
					hostInstanceId: "host-1",
					terminalEpoch: "terminal-2",
				},
				target: {
					sessionId: "runtime-native-2",
					workspaceId: "workspace-1",
					runnerPrincipal: "runner-2",
					runnerInstance: "instance-2",
					channelEpoch: "3",
					hostInstanceId: "host-2",
					terminalEpoch: "terminal-3",
				},
				routeAuthority: source.routeAuthority,
			}),
		).rejects.toMatchObject({
			code: "agent_runtime_transition_response_invalid",
		});
		expect(invokeCommand).not.toHaveBeenCalled();
	});
});
