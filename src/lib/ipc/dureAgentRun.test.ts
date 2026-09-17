import { describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import {
	canonicalAddAgentRunIdempotencyKey,
	createDureAgentRunTransport,
} from "@/lib/ipc/dureAgentRun";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { createAgentRunBackendFixture } from "@/test/dureAgentRunFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const request = {
	projectPath: "/repo",
	providerId: "claude" as const,
	agentName: "claude-1",
	worktree: { kind: "project_root" as const },
	idempotencyKey: "add-agent:project-repo:claude-1",
};
const routeAuthority = testDureBackendRouteAuthority(
	"dure-local",
	"generation-1",
);

describe("Dure Agent Run transport", () => {
	it("projects the run when the backend includes its checkout registration", async () => {
		const fixture = createAgentRunBackendFixture();
		const transport = createDureAgentRunTransport({
			invokeCommand: async (command, arguments_) => {
				const response = await fixture.invokeCommand(command, arguments_);
				const enriched = structuredClone(response) as {
					result: { receipt: Record<string, unknown> };
				};
				enriched.result.receipt.checkoutRegistration = {
					repositoryPath: "/repo",
					instance: {
						schemaVersion: 1,
						canonicalPath: "/repo/.worktrees/claude-1",
						gitCommonDir: "/repo/.git",
						gitDir: "/repo/.git/worktrees/claude-1",
						instanceToken: `dwt1_${"a".repeat(32)}`,
					},
				};
				return enriched;
			},
		});
		await expect(transport.run(request, routeAuthority)).resolves.toMatchObject(
			{
				agentId: "agent-run-1",
				operationId: "agent-spawn-operation-1",
			},
		);
		expect(fixture.operations).toEqual([
			"agent_spawn.preview",
			"agent_spawn.apply",
		]);
	});

	it("runs preview and apply on one backend generation and projects the exact runtime", async () => {
		const fixture = createAgentRunBackendFixture();
		const routes: unknown[] = [];
		const transport = createDureAgentRunTransport({
			invokeCommand: (command, arguments_) => {
				routes.push(arguments_.route);
				return fixture.invokeCommand(command, arguments_);
			},
		});

		await expect(transport.run(request, routeAuthority)).resolves.toMatchObject(
			{
				interactionProfile: "native_cli",
				operationId: "agent-spawn-operation-1",
				agentId: "agent-run-1",
				projectId: "project-repo",
				providerId: "claude",
				worktree: { kind: "project_root" },
				generation: {
					hostInstanceId: "host-instance",
					terminalEpoch: "terminal-epoch",
				},
			},
		);
		expect(fixture.operations).toEqual([
			"agent_spawn.preview",
			"agent_spawn.apply",
		]);
		expect(routes).toEqual([
			{ kind: "exact", authority: routeAuthority },
			{ kind: "exact", authority: routeAuthority },
		]);
	});

	it("recovers a committed apply after only its response is lost", async () => {
		const fixture = createAgentRunBackendFixture();
		const operations: string[] = [];
		let appliedResponse: unknown;
		let applyEffects = 0;
		const transport = createDureAgentRunTransport({
			invokeCommand: async (command, arguments_) => {
				const call = arguments_ as {
					operation: string;
					body: Record<string, unknown>;
					route: unknown;
				};
				operations.push(call.operation);
				if (call.operation === "agent_spawn.apply") {
					applyEffects += 1;
					appliedResponse = await fixture.invokeCommand(command, arguments_);
					throw { code: "backend_transport_timeout", message: "response lost" };
				}
				if (call.operation === "agent_spawn.status") {
					expect(call.body).toEqual({
						schemaVersion: 1,
						idempotencyKey: request.idempotencyKey,
					});
					expect(call.route).toEqual({
						kind: "exact",
						authority: routeAuthority,
					});
					return appliedResponse;
				}
				return fixture.invokeCommand(command, arguments_);
			},
		});

		await expect(transport.run(request, routeAuthority)).resolves.toMatchObject(
			{
				operationId: "agent-spawn-operation-1",
				agentId: "agent-run-1",
			},
		);
		expect(operations).toEqual([
			"agent_spawn.preview",
			"agent_spawn.apply",
			"agent_spawn.status",
		]);
		expect(applyEffects).toBe(1);
	});

	it("recovers a committed apply after the backend reports retry-same", async () => {
		const fixture = createAgentRunBackendFixture();
		const operations: string[] = [];
		let committedResponse: unknown;
		let applyEffects = 0;
		const transport = createDureAgentRunTransport({
			invokeCommand: async (command, arguments_) => {
				const call = arguments_ as { operation: string };
				operations.push(call.operation);
				if (call.operation === "agent_spawn.apply") {
					applyEffects += 1;
					committedResponse = await fixture.invokeCommand(command, arguments_);
					throw new DureBackendRequestError(
						"backend_request_deadline_exceeded",
						"the apply response missed its deadline",
						{ kind: "operation", disposition: "retry_same" },
					);
				}
				if (call.operation === "agent_spawn.status") return committedResponse;
				return fixture.invokeCommand(command, arguments_);
			},
		});

		await expect(transport.run(request, routeAuthority)).resolves.toMatchObject(
			{
				operationId: "agent-spawn-operation-1",
				agentId: "agent-run-1",
			},
		);
		expect(operations).toEqual([
			"agent_spawn.preview",
			"agent_spawn.apply",
			"agent_spawn.status",
		]);
		expect(applyEffects).toBe(1);
	});

	it("recovers the durable receipt when the apply response is malformed", async () => {
		const fixture = createAgentRunBackendFixture();
		const operations: string[] = [];
		let committedResponse: unknown;
		let applyEffects = 0;
		const transport = createDureAgentRunTransport({
			invokeCommand: async (command, arguments_) => {
				const call = arguments_ as { operation: string };
				operations.push(call.operation);
				if (call.operation === "agent_spawn.apply") {
					applyEffects += 1;
					committedResponse = await fixture.invokeCommand(command, arguments_);
					const malformed = structuredClone(committedResponse) as {
						result: { receipt: { operationId?: string } };
					};
					delete malformed.result.receipt.operationId;
					return malformed;
				}
				if (call.operation === "agent_spawn.status") return committedResponse;
				return fixture.invokeCommand(command, arguments_);
			},
		});

		await expect(transport.run(request, routeAuthority)).resolves.toMatchObject(
			{
				operationId: "agent-spawn-operation-1",
				agentId: "agent-run-1",
			},
		);
		expect(operations).toEqual([
			"agent_spawn.preview",
			"agent_spawn.apply",
			"agent_spawn.status",
		]);
		expect(applyEffects).toBe(1);
	});

	it.each([
		["provider_executable_not_found", "ipc.dureRun.providerNotFound"],
		["provider_executable_not_executable", "ipc.dureRun.providerNotExecutable"],
		["provider_executable_lookup_failed", "ipc.dureRun.providerLookupFailed"],
		["provider_executable_path_missing", "ipc.dureRun.providerPathMissing"],
		["future_reason", null],
		["constructor", null],
	])(
		"preserves unchanged-status refusal %s, then retries the same intent",
		async (reasonCode, messageKey) => {
			const fixture = createAgentRunBackendFixture();
			const operations: string[] = [];
			const applyBodies: unknown[] = [];
			let previewResponse: unknown;
			let unavailable = true;
			const failure = {
				code: "agent_spawn_provider_unavailable",
				message: "Provider executable resolution failed.",
				details: { reasonCode, disposition: "retry_same" },
			};
			const transport = createDureAgentRunTransport({
				invokeCommand: async (command, arguments_) => {
					const call = arguments_ as { operation: string; body: unknown };
					operations.push(call.operation);
					if (call.operation === "agent_spawn.apply") {
						applyBodies.push(call.body);
						if (unavailable) throw failure;
					}
					if (call.operation === "agent_spawn.status") return previewResponse;
					const response = await fixture.invokeCommand(command, arguments_);
					if (call.operation === "agent_spawn.preview")
						previewResponse = response;
					return response;
				},
			});

			await expect(
				transport.run(request, routeAuthority),
			).rejects.toMatchObject({
				code: failure.code,
				message: messageKey ? t(messageKey) : failure.message,
				details: {
					reasonCode,
					idempotencyKey: request.idempotencyKey,
					operationId: "agent-spawn-operation-1",
					retry: "same_intent",
				},
			});
			expect(operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
				"agent_spawn.status",
			]);
			unavailable = false;
			await expect(
				transport.run(request, routeAuthority),
			).resolves.toMatchObject({
				operationId: "agent-spawn-operation-1",
				agentId: "agent-run-1",
			});
			expect(applyBodies).toHaveLength(2);
			expect(applyBodies[1]).toEqual(applyBodies[0]);
		},
	);

	it("retains the exact intent when apply and status outcomes are unreachable", async () => {
		const fixture = createAgentRunBackendFixture();
		const transport = createDureAgentRunTransport({
			invokeCommand: async (command, arguments_) => {
				const call = arguments_ as { operation: string };
				if (call.operation === "agent_spawn.apply") {
					await fixture.invokeCommand(command, arguments_);
					throw { code: "backend_transport_timeout", message: "response lost" };
				}
				if (call.operation === "agent_spawn.status") {
					throw { code: "backend_transport_unreachable", message: "offline" };
				}
				return fixture.invokeCommand(command, arguments_);
			},
		});

		await expect(transport.run(request, routeAuthority)).rejects.toMatchObject({
			code: "agent_run_outcome_unknown",
			details: {
				idempotencyKey: request.idempotencyKey,
				operationId: "agent-spawn-operation-1",
				retry: "same_intent",
			},
		});
	});

	/** 2026-08-31 라이브 재현: worktree 단계는 커밋되고 structured_launch가
	 *  claude_conversation_host_attach_failed로 실패한 영수증. 예전에는 "Run이
	 *  완료되지 않았습니다 — 같은 요청으로 상태를 이어가세요"로 보고돼, 끝난
	 *  실패를 진행 중인 것처럼 말하고 원인을 버렸다. */
	/** The provider never confirmed the prompt: the agent exists but may have no
	 *  task. That is not success, and the message must not tell the user to
	 *  simply try again — the bytes may already be in its terminal. */
	it("reports an unconfirmed prompt as its own outcome, with the evidence", async () => {
		const fixture = createAgentRunBackendFixture();
		const transport = createDureAgentRunTransport({
			invokeCommand: async (command, arguments_) => {
				const call = arguments_ as { operation: string };
				const response = (await fixture.invokeCommand(command, arguments_)) as {
					result?: {
						receipt?: {
							state?: string;
							completed?: unknown[];
							recovery?: unknown;
						};
					};
				};
				const receipt = response?.result?.receipt;
				if (call.operation === "agent_spawn.apply" && receipt) {
					receipt.state = "prompt_delivery_uncertain";
					receipt.completed = (receipt.completed ?? []).slice(0, 2);
					receipt.recovery = {
						kind: "do_not_replay_prompt",
						attempt: 1,
						error_code: "agent_spawn_prompt_unanswered",
						error_detail:
							"the provider produced no output after the prompt (through output seq 7)",
						inputs: {
							stage: "prompt_delivery",
							session_id: "session-agent-run-1",
							prompt_digest: `sha256:${"c".repeat(64)}`,
						},
					};
				}
				return response;
			},
		});

		await expect(transport.run(request, routeAuthority)).rejects.toMatchObject({
			code: "agent_run_prompt_uncertain",
			message: expect.stringContaining("no output after the prompt"),
			details: {
				errorCode: "agent_spawn_prompt_unanswered",
			},
		});
	});

	it("reports which stage failed instead of calling a finished failure incomplete", async () => {
		const fixture = createAgentRunBackendFixture();
		const transport = createDureAgentRunTransport({
			invokeCommand: async (command, arguments_) => {
				const call = arguments_ as { operation: string };
				const response = (await fixture.invokeCommand(command, arguments_)) as {
					result?: {
						receipt?: {
							state?: string;
							completed?: unknown[];
							recovery?: unknown;
						};
					};
				};
				const receipt = response?.result?.receipt;
				if (call.operation === "agent_spawn.apply" && receipt) {
					receipt.state = "retry_required";
					receipt.completed = (receipt.completed ?? []).slice(0, 1);
					receipt.recovery = {
						kind: "retry_required",
						stage: "structured_launch",
						failed_attempt: 1,
						error_code: "claude_conversation_host_attach_failed",
						error_detail:
							"host_exited_before_ready: capability_boundary_mismatch",
					};
				}
				return response;
			},
		});

		// The evidence rides in the details AND in the message: the OS dialog
		// that reports a failed start shows the message alone.
		await expect(transport.run(request, routeAuthority)).rejects.toMatchObject({
			code: "agent_run_stage_failed",
			message: expect.stringContaining("capability_boundary_mismatch"),
			details: {
				stage: "structured_launch",
				errorCode: "claude_conversation_host_attach_failed",
				detail: "host_exited_before_ready: capability_boundary_mismatch",
			},
		});
	});

	it("consumes the existing durable receipt when the same action is retried", async () => {
		const fixture = createAgentRunBackendFixture();
		const operations: string[] = [];
		let succeededResponse: unknown;
		let previewCount = 0;
		const transport = createDureAgentRunTransport({
			invokeCommand: async (command, arguments_) => {
				const call = arguments_ as { operation: string };
				operations.push(call.operation);
				if (call.operation === "agent_spawn.preview") {
					previewCount += 1;
					if (previewCount > 1) {
						throw new DureBackendRequestError(
							"agent_spawn_idempotency_conflict",
							"the action already owns a durable Run",
							{ kind: "operation", disposition: "terminal" },
						);
					}
				}
				if (call.operation === "agent_spawn.apply") {
					succeededResponse = await fixture.invokeCommand(command, arguments_);
					return succeededResponse;
				}
				if (call.operation === "agent_spawn.status") return succeededResponse;
				return fixture.invokeCommand(command, arguments_);
			},
		});

		await transport.run(request, routeAuthority);
		await expect(transport.run(request, routeAuthority)).resolves.toMatchObject(
			{
				operationId: "agent-spawn-operation-1",
				agentId: "agent-run-1",
			},
		);
		expect(operations).toEqual([
			"agent_spawn.preview",
			"agent_spawn.apply",
			"agent_spawn.preview",
			"agent_spawn.status",
		]);
	});

	it("preserves an in-flight backend replacement for successor replay", async () => {
		const fixture = createAgentRunBackendFixture();
		const transport = createDureAgentRunTransport({
			invokeCommand: async (command, arguments_) => {
				const call = arguments_ as { operation: string };
				if (call.operation === "agent_spawn.apply") {
					throw {
						code: "backend_transport_generation_changed",
						message: "backend generation changed",
					};
				}
				if (call.operation === "agent_spawn.status") {
					throw {
						code: "backend_transport_authority_changed",
						message: "stale exact route",
					};
				}
				return fixture.invokeCommand(command, arguments_);
			},
		});

		await expect(transport.run(request, routeAuthority)).rejects.toMatchObject({
			code: "backend_transport_generation_changed",
			details: {
				operationId: "agent-spawn-operation-1",
				retry: "same_intent",
			},
		});
	});

	it("continues the same durable Run after a recoverable stage failure", async () => {
		const fixture = createAgentRunBackendFixture();
		const operations: string[] = [];
		const applyBodies: Record<string, unknown>[] = [];
		let retryResponse: unknown;
		let applyCount = 0;
		const transport = createDureAgentRunTransport({
			invokeCommand: async (command, arguments_) => {
				const call = arguments_ as {
					operation: string;
					body: Record<string, unknown>;
				};
				if (command !== "dure_backend_request") {
					return fixture.invokeCommand(command, arguments_);
				}
				operations.push(call.operation);
				if (call.operation === "agent_spawn.preview") {
					return fixture.invokeCommand(command, arguments_);
				}
				if (call.operation === "agent_spawn.apply") {
					applyBodies.push(call.body);
					applyCount += 1;
					const response = await fixture.invokeCommand(command, arguments_);
					if (applyCount > 1) return response;
					const retry = structuredClone(response) as {
						result: {
							receipt: {
								state: string;
								lastSequence: number;
								completed: unknown[];
								recovery: Record<string, unknown>;
							};
						};
					};
					retry.result.receipt.state = "retry_required";
					retry.result.receipt.lastSequence = 5;
					retry.result.receipt.completed = [];
					retry.result.receipt.recovery = {
						kind: "retry_required",
						stage: "structured_launch",
						failed_attempt: 1,
						error_code: "claude_conversation_host_attach_failed",
						inputs: { stage: "structured_launch" },
					};
					retryResponse = retry;
					return retry;
				}
				if (call.operation === "agent_spawn.status") return retryResponse;
				return fixture.invokeCommand(command, arguments_);
			},
		});

		await expect(transport.run(request, routeAuthority)).resolves.toMatchObject(
			{
				operationId: "agent-spawn-operation-1",
				agentId: "agent-run-1",
			},
		);
		expect(operations).toEqual([
			"agent_spawn.preview",
			"agent_spawn.apply",
			"agent_spawn.apply",
		]);
		expect(applyBodies).toEqual([
			expect.objectContaining({
				operationId: "agent-spawn-operation-1",
				expectedLastSequence: 1,
			}),
			expect.objectContaining({
				operationId: "agent-spawn-operation-1",
				expectedLastSequence: 5,
			}),
		]);
	});

	it("preserves auto-edit as an exact preview override and effective run mode", async () => {
		const fixture = createAgentRunBackendFixture();
		const calls: Array<{ operation: string; body: Record<string, unknown> }> =
			[];
		const transport = createDureAgentRunTransport({
			invokeCommand: async (command, arguments_) => {
				const call = arguments_ as {
					operation: string;
					body: Record<string, unknown>;
				};
				calls.push({ operation: call.operation, body: call.body });
				return fixture.invokeCommand(command, arguments_);
			},
		});

		await expect(
			transport.run(
				{ ...request, permissionOverride: "auto_edit" },
				routeAuthority,
			),
		).resolves.toMatchObject({ permissionMode: "auto_edit" });
		expect(
			calls.find((call) => call.operation === "agent_spawn.preview")?.body,
		).toMatchObject({ permissionOverride: "auto_edit" });
	});

	it("rejects a run receipt that loses the requested auto-edit override", async () => {
		const fixture = createAgentRunBackendFixture({
			mutateApplyResult(result) {
				const changed = structuredClone(result) as {
					receipt: { plan: { request: { permissionMode: string } } };
				};
				changed.receipt.plan.request.permissionMode = "default";
				return changed;
			},
		});
		const transport = createDureAgentRunTransport({
			invokeCommand: fixture.invokeCommand,
		});

		await expect(
			transport.run(
				{ ...request, permissionOverride: "auto_edit" },
				routeAuthority,
			),
		).rejects.toMatchObject({ code: "agent_run_receipt_invalid" });
	});

	it("does not apply a preview after its backend route is replaced", async () => {
		const fixture = createAgentRunBackendFixture();
		let activeGeneration = "generation-1";
		let effects = 0;
		const invokeCommand = async (
			command: string,
			arguments_: Record<string, unknown>,
		) => {
			const call = arguments_ as {
				route:
					| { kind: "selected" }
					| {
							kind: "exact";
							authority: { backend: { generation: string } };
					  };
				operation: string;
			};
			if (call.operation === "agent_spawn.preview") {
				const result = await fixture.invokeCommand(command, arguments_);
				activeGeneration = "generation-2";
				return result;
			}
			if (
				call.operation === "agent_spawn.apply" &&
				call.route.kind === "exact" &&
				call.route.authority.backend.generation !== activeGeneration
			) {
				throw {
					code: "backend_transport_authority_changed",
					message: "backend route changed",
				};
			}
			effects += 1;
			const response = (await fixture.invokeCommand(
				command,
				arguments_,
			)) as Record<string, unknown>;
			return {
				...response,
				backendGeneration: activeGeneration,
				routeAuthority: testDureBackendRouteAuthority(
					"dure-local",
					activeGeneration,
				),
			};
		};
		const transport = createDureAgentRunTransport({ invokeCommand });

		await expect(transport.run(request, routeAuthority)).rejects.toMatchObject({
			code: "backend_transport_authority_changed",
		});
		expect(effects).toBe(0);
	});

	it("projects a structured receipt without inventing a native session", async () => {
		const fixture = createAgentRunBackendFixture({
			interactionProfile: "structured_protocol",
		});
		const transport = createDureAgentRunTransport({
			invokeCommand: fixture.invokeCommand,
		});

		const result = await transport.run(request, routeAuthority);

		expect(result).toMatchObject({
			interactionProfile: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: "interaction-run-1",
			executionProfile: { kind: "provider_default" },
		});
		expect(result).not.toHaveProperty("sessionId");
		expect(result).not.toHaveProperty("generation");
	});

	it("resumes an exact provider conversation in the source Agent's existing workspace", async () => {
		const fixture = createAgentRunBackendFixture({
			interactionProfile: "structured_protocol",
		});
		const transport = createDureAgentRunTransport({
			invokeCommand: fixture.invokeCommand,
		});

		await expect(
			transport.run(
				{
					...request,
					worktree: {
						kind: "existing_workspace",
						sourceAgentId: "agent-source-1",
						workspaceId: "workspace-source-1",
					},
					providerConversationRef: "threads/2026-08-30:turn_1",
				},
				routeAuthority,
			),
		).resolves.toMatchObject({
			interactionProfile: "structured_protocol",
			workspaceId: "workspace-source-1",
			providerConversationRef: "threads/2026-08-30:turn_1",
			worktree: {
				kind: "existing_workspace",
				sourceAgentId: "agent-source-1",
				rootPath: "/repo/.worktrees/source",
			},
		});
	});

	it("rejects a runtime generation that disagrees with the journal plan", async () => {
		const fixture = createAgentRunBackendFixture({
			mutateApplyResult(result) {
				const changed = structuredClone(result);
				const receipt = changed.receipt as {
					completed: Array<{ evidence: { session?: { workspaceId: string } } }>;
				};
				const runtime = receipt.completed[1]?.evidence.session;
				if (runtime) runtime.workspaceId = "workspace-foreign";
				return changed;
			},
		});
		const transport = createDureAgentRunTransport({
			invokeCommand: fixture.invokeCommand,
		});

		await expect(transport.run(request, routeAuthority)).rejects.toMatchObject({
			code: "agent_run_receipt_invalid",
		});
	});

	it("projects an advanced runtime only with its matching effective create key", async () => {
		const fixture = createAgentRunBackendFixture({
			mutateApplyResult(result) {
				const changed = structuredClone(result) as {
					receipt: {
						completed: Array<{
							evidence: {
								session?: { sessionId: string };
								launch_idempotency_key?: string;
							};
						}>;
					};
				};
				const runtime = changed.receipt.completed[1]?.evidence;
				if (runtime?.session) {
					runtime.session.sessionId = "session-run-1-successor";
					runtime.launch_idempotency_key = "spawn-runtime:successor";
				}
				return changed;
			},
		});
		const transport = createDureAgentRunTransport({
			invokeCommand: fixture.invokeCommand,
		});

		await expect(transport.run(request, routeAuthority)).resolves.toMatchObject(
			{
				sessionId: "session-run-1-successor",
				launchIdempotencyKey: "spawn-runtime:successor",
			},
		);
	});

	it("rejects a runtime that mixes prepared and successor identity halves", async () => {
		for (const mix of [
			{
				sessionId: "session-run-1-successor",
				key: "spawn-runtime:agent-spawn-operation-1",
			},
			{ sessionId: "session-run-1", key: "spawn-runtime:successor" },
		]) {
			const fixture = createAgentRunBackendFixture({
				mutateApplyResult(result) {
					const changed = structuredClone(result) as {
						receipt: {
							completed: Array<{
								evidence: {
									session?: { sessionId: string };
									launch_idempotency_key?: string;
								};
							}>;
						};
					};
					const runtime = changed.receipt.completed[1]?.evidence;
					if (runtime?.session) {
						runtime.session.sessionId = mix.sessionId;
						runtime.launch_idempotency_key = mix.key;
					}
					return changed;
				},
			});
			const transport = createDureAgentRunTransport({
				invokeCommand: fixture.invokeCommand,
			});
			await expect(
				transport.run(request, routeAuthority),
			).rejects.toMatchObject({
				code: "agent_run_receipt_invalid",
			});
		}
	});

	it("accepts a persisted creator generation from the active backend successor", async () => {
		const fixture = createAgentRunBackendFixture({
			backendGeneration: "generation-successor",
			planBackendGeneration: "generation-creator",
		});
		const transport = createDureAgentRunTransport({
			invokeCommand: fixture.invokeCommand,
		});

		await expect(
			transport.run(
				request,
				testDureBackendRouteAuthority("dure-local", "generation-successor"),
			),
		).resolves.toMatchObject({
			backend: { generation: "generation-successor" },
			operationId: "agent-spawn-operation-1",
		});
	});

	it("delegates request admission to the backend boundary", async () => {
		const failure = new DureBackendRequestError(
			"agent_spawn_preview_request_invalid",
			"invalid request",
			{ kind: "operation", disposition: "terminal" },
		);
		const invokeCommand = vi.fn().mockRejectedValue(failure);
		const transport = createDureAgentRunTransport({ invokeCommand });

		await expect(
			transport.run(
				{ ...request, agentName: "Invalid Agent Name" },
				routeAuthority,
			),
		).rejects.toMatchObject({ code: "agent_spawn_preview_request_invalid" });
		expect(invokeCommand).toHaveBeenCalledOnce();
	});

	it("rejects a contradictory receipt lifecycle at the response boundary", async () => {
		const fixture = createAgentRunBackendFixture({
			mutateApplyResult(result) {
				const changed = structuredClone(result) as {
					receipt: {
						state: string;
						recovery: Record<string, unknown>;
						terminalCode: string | null;
					};
				};
				changed.receipt.state = "failed";
				changed.receipt.recovery = {
					kind: "retry_required",
					error_code: "launch_failed",
				};
				changed.receipt.terminalCode = "launch_failed";
				return changed;
			},
		});
		const transport = createDureAgentRunTransport({
			invokeCommand: fixture.invokeCommand,
		});

		await expect(transport.run(request, routeAuthority)).rejects.toMatchObject({
			code: "agent_run_receipt_invalid",
		});
	});

	it("scopes retry identity to one durable action", () => {
		expect(canonicalAddAgentRunIdempotencyKey("qd_123")).toBe(
			"add-agent:qd_123",
		);
	});

	it("sends a qualified provider model unchanged and verifies the plan echo", async () => {
		const fixture = createAgentRunBackendFixture();
		const calls: Array<{ operation: string; body: Record<string, unknown> }> =
			[];
		const invokeCommand = async (
			command: string,
			arguments_: Record<string, unknown>,
		) => {
			const call = arguments_ as {
				operation: string;
				body: Record<string, unknown>;
			};
			calls.push({ operation: call.operation, body: call.body });
			return fixture.invokeCommand(command, arguments_);
		};
		const transport = createDureAgentRunTransport({ invokeCommand });

		await transport.run(
			{
				...request,
				model: "provider-next[1m]",
				effort: "xhigh",
			} as unknown as Parameters<typeof transport.run>[0],
			routeAuthority,
		);

		const preview = calls.find(
			(call) => call.operation === "agent_spawn.preview",
		);
		expect(preview?.body.model).toBe("provider-next[1m]");
		expect(preview?.body.effort).toBe("xhigh");
	});

	it("sends the PTY interaction preference conditionally and verifies the plan echo", async () => {
		const fixture = createAgentRunBackendFixture();
		const calls: Array<{ operation: string; body: Record<string, unknown> }> =
			[];
		const invokeCommand = async (
			command: string,
			arguments_: Record<string, unknown>,
		) => {
			const call = arguments_ as {
				operation: string;
				body: Record<string, unknown>;
			};
			calls.push({ operation: call.operation, body: call.body });
			return fixture.invokeCommand(command, arguments_);
		};
		const transport = createDureAgentRunTransport({ invokeCommand });

		await transport.run(
			{
				...request,
				interactionPreference: "native_cli",
			} as unknown as Parameters<typeof transport.run>[0],
			routeAuthority,
		);

		const preview = calls.find(
			(call) => call.operation === "agent_spawn.preview",
		);
		expect(preview?.body.interactionPreference).toBe("native_cli");
	});

	it("fails closed when the plan omits an echoed interaction preference", async () => {
		const fixture = createAgentRunBackendFixture({
			mutateApplyResult(result) {
				const changed = structuredClone(result) as {
					receipt: { plan: { request: Record<string, unknown> } };
				};
				delete changed.receipt.plan.request.interactionPreference;
				return changed;
			},
		});
		const transport = createDureAgentRunTransport({
			invokeCommand: fixture.invokeCommand,
		});

		await expect(
			transport.run(
				{
					...request,
					interactionPreference: "native_cli",
				} as unknown as Parameters<typeof transport.run>[0],
				routeAuthority,
			),
		).rejects.toMatchObject({ code: "agent_run_receipt_invalid" });
	});

	it("fails closed when the plan omits an echoed effort", async () => {
		const fixture = createAgentRunBackendFixture({
			mutateApplyResult(result) {
				const changed = structuredClone(result) as {
					receipt: { plan: { request: Record<string, unknown> } };
				};
				delete changed.receipt.plan.request.effort;
				return changed;
			},
		});
		const transport = createDureAgentRunTransport({
			invokeCommand: fixture.invokeCommand,
		});

		await expect(
			transport.run(
				{
					...request,
					effort: "xhigh",
				} as unknown as Parameters<typeof transport.run>[0],
				routeAuthority,
			),
		).rejects.toMatchObject({ code: "agent_run_receipt_invalid" });
	});

	it("fails closed when the plan omits an echoed model", async () => {
		const fixture = createAgentRunBackendFixture({
			mutateApplyResult(result) {
				const changed = structuredClone(result) as {
					receipt: { plan: { request: Record<string, unknown> } };
				};
				delete changed.receipt.plan.request.model;
				return changed;
			},
		});
		const transport = createDureAgentRunTransport({
			invokeCommand: fixture.invokeCommand,
		});

		await expect(
			transport.run(
				{
					...request,
					model: "opus",
				} as unknown as Parameters<typeof transport.run>[0],
				routeAuthority,
			),
		).rejects.toMatchObject({ code: "agent_run_receipt_invalid" });
	});
});
