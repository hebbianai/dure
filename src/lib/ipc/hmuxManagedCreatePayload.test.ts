import { describe, expect, it } from "vitest";
import { parseHmuxManagedCreateAdvanceResolutionV1 } from "./hmuxManagedCreatePayload";

const expected = {
	idempotencyKey: "create-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	credentialId: "credential-1",
	credentialGeneration: 3,
};

function session() {
	return {
		sessionId: "session-1",
		sessionName: null,
		workspaceId: "workspace-1",
		sessionClass: "managed",
		lifecycle: "ready",
		manifestLifecycle: "ready",
		health: "current_healthy",
		hostBuildVersion: "0.1.4+test",
		clientSelection: "direct_rust",
		inputAllowed: true,
		detachOnly: false,
		diagnostic: null,
		runtimeHost: null,
		hostProcessAlive: null,
		terminalEpoch: "terminal-1",
		stopFence: {
			runnerPrincipal: "principal-1",
			runnerInstance: "runner-1",
			channelEpoch: "1",
			hostInstanceId: "host-1",
			terminalEpoch: "terminal-1",
		},
		outputSeq: "0",
		capabilities: ["managed_stop"],
		retirementPolicy: null,
	};
}

describe("local managed create advance payload", () => {
	it("accepts only a ledger-owned successor identity for advanced", () => {
		const resolution = parseHmuxManagedCreateAdvanceResolutionV1(
			{
				state: "advanced",
				receipt: {
					idempotencyKey: "create-successor",
					cwd: "/workspace",
					credentialId: "credential-1",
					credentialGeneration: 3,
					outcome: "created",
					session: {
						...session(),
						sessionId: "session-successor",
					},
				},
			},
			expected,
		);

		expect(resolution).toMatchObject({
			state: "advanced",
			receipt: {
				idempotencyKey: "create-successor",
				session: { sessionId: "session-successor" },
			},
		});
		expect(
			parseHmuxManagedCreateAdvanceResolutionV1(
				{
					state: "advanced",
					receipt: {
						idempotencyKey: expected.idempotencyKey,
						credentialId: "credential-1",
						credentialGeneration: 3,
						outcome: "reused",
						session: session(),
					},
				},
				expected,
			),
		).toBeUndefined();
	});

	it("parses and normalizes the complete current receipt once", () => {
		const resolution = parseHmuxManagedCreateAdvanceResolutionV1(
			{
				state: "current",
				receipt: {
					idempotencyKey: "create-1",
					cwd: "/workspace",
					credentialId: "credential-1",
					credentialGeneration: 3,
					outcome: "created",
					session: session(),
				},
			},
			expected,
		);

		expect(resolution).toMatchObject({
			state: "current",
			receipt: {
				idempotencyKey: "create-1",
				session: {
					lifecycle: "ready",
					outputSeq: "0",
					capabilities: ["managed_stop"],
				},
			},
		});
		if (resolution?.state === "current") {
			expect(resolution.receipt.session).not.toHaveProperty("sessionName");
			expect(resolution.receipt.session).not.toHaveProperty("diagnostic");
		}
	});

	it("rejects a normalization escape hatch from the closed advance result", () => {
		expect(
			parseHmuxManagedCreateAdvanceResolutionV1(
				{
					state: "normalize_existing",
					existing: {
						idempotencyKey: "create-1",
						outcome: "reused",
						session: session(),
					},
				},
				expected,
			),
		).toBeUndefined();
	});

	it("drops additive presentation metadata while retaining the exact generation", () => {
		const resolution = parseHmuxManagedCreateAdvanceResolutionV1(
			{
				state: "current",
				newResolutionDiagnostic: true,
				receipt: {
					idempotencyKey: "create-1",
					credentialId: "credential-1",
					credentialGeneration: 3,
					outcome: "created",
					newReceiptDiagnostic: { revision: 2 },
					session: {
						...session(),
						stopFence: { ...session().stopFence, newGenerationDiagnostic: true },
						health: "future_health_state",
						inputAllowed: "future_policy",
						capabilities: ["managed_stop", 7],
						newSessionDiagnostic: { revision: 2 },
					},
				},
			},
			expected,
		);

		expect(resolution).toMatchObject({
			state: "current",
			receipt: {
				session: {
					sessionId: "session-1",
					workspaceId: "workspace-1",
					capabilities: ["managed_stop"],
				},
			},
		});
		if (resolution?.state === "current") {
			expect(resolution).not.toHaveProperty("newResolutionDiagnostic");
			expect(resolution.receipt.session.stopFence).toEqual(session().stopFence);
			expect(resolution.receipt.session).not.toHaveProperty("health");
			expect(resolution.receipt.session).not.toHaveProperty(
				"newSessionDiagnostic",
			);
		}
	});
});
