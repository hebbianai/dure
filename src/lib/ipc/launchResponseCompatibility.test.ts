import { describe, expect, it, vi } from "vitest";
import { resolveAgentRuntimeCredentialPreparation } from "@/lib/agents/agentRuntimeCredentialSwitch";
import { parseManagedCreateAdvanceResolution } from "@/lib/hmux/managed/managedCreateResolution";
import { createDureAgentRunTransport } from "@/lib/ipc/dureAgentRun";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { registerDureProviderCredentialProfile } from "@/lib/ipc/dureProviderCredentialProfile";
import { createAgentRunBackendFixture } from "@/test/dureAgentRunFixtures";
import {
	agentRuntimeBackendEnvelope,
	agentRuntimeProjectionContext,
	nativeRuntimeReceipt,
} from "@/test/dureAgentRuntimeFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

/** A newer service may append metadata at any response level. */
function withMetadata(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withMetadata);
	if (!value || typeof value !== "object") return value;
	return {
		...Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, withMetadata(item)]),
		),
		futureObservation: "not an execution input",
	};
}

describe("launch responses from an additively extended backend", () => {
	it.each(["codex", "claude"] as const)(
		"registers %s credentials despite extra response metadata",
		async (providerId) => {
			const routeAuthority = testDureBackendRouteAuthority(
				"dure-local",
				"generation-1",
			);
			const invokeCommand = vi.fn().mockResolvedValue(
				withMetadata({
					schemaVersion: 1,
					backendId: "dure-local",
					backendGeneration: "generation-1",
					routeAuthority,
					result: {
						schemaVersion: 1,
						profile: {
							schemaVersion: 1,
							providerId,
							referenceId: "account-b",
							credentialGeneration: "credential-b-1",
						},
					},
				}),
			);
			await expect(
				registerDureProviderCredentialProfile(
					{
						providerId,
						referenceId: "account-b",
						profileDirectoryName: `${providerId}-b`,
					},
					{ routeAuthority, invokeCommand },
				),
			).resolves.toEqual({
				kind: "credential_reference",
				reference_id: "account-b",
				credential_generation: "credential-b-1",
			});
			expect(JSON.stringify(invokeCommand.mock.calls)).not.toContain(
				"futureObservation",
			);
		},
	);

	it.each(["native_cli", "structured_protocol"] as const)(
		"inspects and switches a %s runtime with extra metadata",
		async (interactionProfile) => {
			const source = agentRuntimeBackendEnvelope();
			const receipt =
				interactionProfile === "native_cli"
					? nativeRuntimeReceipt(
							source.result.receipt.executionProfile,
							1,
							"native-launch-1",
						)
					: source.result.receipt;
			const invokeCommand = vi
				.fn()
				.mockResolvedValueOnce(
					withMetadata({
						...source,
						result: {
							schemaVersion: 1,
							state: "stable",
							receipt,
							projectionContext: agentRuntimeProjectionContext(),
						},
					}),
				)
				.mockResolvedValueOnce(
					withMetadata({
						...source,
						result: {
							schemaVersion: 1,
							receipt: { ...receipt, selectionRevision: 2 },
						},
					}),
				);
			const client = createDureAgentRuntimeClient({ invokeCommand });
			const observed = await client.inspect("agent-1");
			expect(observed).toMatchObject({ state: "stable", interactionProfile });
			const result = await client.transition({
				agentId: "agent-1",
				targetInteractionProfile: interactionProfile,
				routeAuthority: observed.routeAuthority,
			});
			expect(result).toMatchObject({
				agentId: "agent-1",
				interactionProfile,
				selectionRevision: 2,
			});
			expect(JSON.stringify(invokeCommand.mock.calls)).not.toContain(
				"futureObservation",
			);
		},
	);

	it.each([
		["codex", "native_cli"],
		["claude", "native_cli"],
		["codex", "structured_protocol"],
		["claude", "structured_protocol"],
	] as const)(
		"creates a %s %s agent with extra backend metadata",
		async (providerId, interactionProfile) => {
			const fixture = createAgentRunBackendFixture({
				providerId,
				interactionProfile,
			});
			const invokeCommand = vi.fn(async (command, args) =>
				withMetadata(await fixture.invokeCommand(command, args)),
			);
			const result = await createDureAgentRunTransport({ invokeCommand }).run(
				{
					projectPath: "/repo",
					providerId,
					agentName: "agent-new",
					worktree: { kind: "project_root" },
					idempotencyKey: "create-agent-compatible",
				},
				testDureBackendRouteAuthority("dure-local", "generation-1"),
			);
			expect(result).toMatchObject({
				agentId: "agent-run-1",
				providerId,
				interactionProfile,
			});
			expect(fixture.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]);
			expect(JSON.stringify(invokeCommand.mock.calls)).not.toContain(
				"futureObservation",
			);
		},
	);

	it.each([
		{ state: "current", receipt: { id: "created-1" } },
		{ state: "advanced", receipt: { id: "created-1" } },
		{
			state: "retry_same",
			reason: "pending",
			code: "pending",
			message: "Still preparing",
		},
		{ state: "rejected", code: "invalid_target", message: "Target is invalid" },
	])(
		"preserves a managed creation's $state outcome with added metadata",
		(resolution) => {
			const parseReceipt = (value: unknown) =>
				value &&
				typeof value === "object" &&
				"id" in value &&
				value.id === "created-1"
					? { id: value.id }
					: undefined;
			expect(
				parseManagedCreateAdvanceResolution(
					withMetadata(resolution),
					parseReceipt,
				),
			).toEqual(resolution);
		},
	);

	it.each(["codex", "claude"] as const)(
		"does not require a workspace path to select the local %s default account",
		(provider) => {
			const context = agentRuntimeProjectionContext("agent-1", provider);
			context.workspace.rootPath = "";
			const prepare = resolveAgentRuntimeCredentialPreparation({
				agentId: "agent-1",
				backendProfileId: "local",
				routeAuthority: testDureBackendRouteAuthority(
					"dure-local",
					"generation-1",
				),
				action: { targetCredentialId: null },
				projectionContext: {
					...context,
					schemaVersion: 1,
					identity: { kind: "registered" },
					agent: { ...context.agent, providerId: provider },
				},
				agent: undefined,
				accounts: [],
				sshHosts: [],
			});
			expect(prepare.targetCredentialId).toBeNull();
		},
	);
});
