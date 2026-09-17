import { describe, expect, it, vi } from "vitest";
import { handleCliStructuredRunPresentation } from "@/lib/cli/cliStructuredRunPresentation";

function request() {
	return {
		schemaVersion: 1,
		interactionProfile: "structured_protocol",
		backendProfileId: "local",
		backend: { id: "dure-local", generation: "generation-1" },
		operationId: "spawn-1",
		agentId: "agent-1",
		agentName: "claude-chat-1",
		projectId: "project-1",
		projectPath: "/repo",
		providerId: "claude",
		executionProfile: { kind: "provider_default" },
		interactionSessionId: "interaction-1",
		workspaceId: "workspace-1",
		worktree: { kind: "project_root" },
		permissionMode: "default",
		spaceId: "space-1",
		windowLabel: "main",
	};
}

describe("handleCliStructuredRunPresentation", () => {
	it("preserves the backend's explicit checkout destination when presenting Chat", async () => {
		const worktree = {
			kind: "dedicated",
			branch: "agent/custom",
			directoryName: "custom",
			rootPath: "/selected/work/custom",
		};
		const present = vi.fn(async () => ({ ok: true }));
		const result = await handleCliStructuredRunPresentation(
			{ ...request(), worktree },
			"request-custom-checkout",
			{ claim: async () => true, present, presentBackground: vi.fn() },
		);
		expect(result).toEqual({ ok: true });
		expect(present).toHaveBeenCalledWith(
			expect.objectContaining({ worktree }),
			expect.any(Object),
		);
	});

	it("claims once and presents one typed structured Agent pane", async () => {
		const claim = vi.fn(async () => true);
		const present = vi.fn(async (run) => ({
			ok: true,
			pane: {
				spaceId: "space-1",
				panelId: `agent:${run.agentId}`,
				agentId: run.agentId,
				interactionSessionId: run.interactionSessionId,
				interactionProfile: "structured_protocol",
				outcome: "created",
			},
		}));

		const result = await handleCliStructuredRunPresentation(
			request(),
			"request-1",
			{ claim, present, presentBackground: vi.fn() },
		);

		expect(claim).toHaveBeenCalledOnce();
		expect(present).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
				interactionProfile: "structured_protocol",
			}),
			{
				executionTarget: { source: "local", hostId: "local" },
				projectPath: "/repo",
				spaceId: "space-1",
				windowLabel: "main",
			},
		);
		expect(result).toMatchObject({
			ok: true,
			pane: { panelId: "agent:agent-1" },
		});
	});

	it("preserves a canonical path-shaped provider conversation identity", async () => {
		const present = vi.fn(async () => ({ ok: true }));
		const providerConversationRef = "threads/2026-08-30:turn_1";

		await expect(
			handleCliStructuredRunPresentation(
				{ ...request(), providerConversationRef },
				"request-provider-conversation",
				{ claim: async () => true, present, presentBackground: vi.fn() },
			),
		).resolves.toEqual({ ok: true });
		expect(present).toHaveBeenCalledWith(
			expect.objectContaining({ providerConversationRef }),
			expect.any(Object),
		);
	});

	it.each(["conversation+alias", `/${"a".repeat(160)}`])(
		"rejects a non-canonical provider conversation identity: %s",
		async (providerConversationRef) => {
			const present = vi.fn();
			const result = await handleCliStructuredRunPresentation(
				{ ...request(), providerConversationRef },
				"request-invalid-provider-conversation",
				{ claim: async () => true, present, presentBackground: vi.fn() },
			);

			expect(present).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				ok: false,
				error: { code: "invalid_request" },
			});
		},
	);

	it("returns one typed refusal for an invalid boundary request", async () => {
		const present = vi.fn();
		const result = await handleCliStructuredRunPresentation(
			{ ...request(), interactionSessionId: "" },
			"request-2",
			{ claim: async () => true, present, presentBackground: vi.fn() },
		);

		expect(present).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
	});

	it("presents the exact auto-edit mode selected for a structured run", async () => {
		const present = vi.fn(async () => ({ ok: true }));
		const result = await handleCliStructuredRunPresentation(
			{ ...request(), permissionMode: "auto_edit" },
			"request-auto-edit",
			{ claim: async () => true, present, presentBackground: vi.fn() },
		);

		expect(result).toEqual({ ok: true });
		expect(present).toHaveBeenCalledWith(
			expect.objectContaining({ permissionMode: "auto_edit" }),
			expect.any(Object),
		);
	});

	it("rejects identities that cannot survive persisted projection", async () => {
		for (const invalid of [
			{ ...request(), backendProfileId: "SSH-Team" },
			{ ...request(), operationId: `a${"b".repeat(160)}` },
		]) {
			const present = vi.fn();
			const result = await handleCliStructuredRunPresentation(
				invalid,
				"request-invalid-identity",
				{ claim: async () => true, present, presentBackground: vi.fn() },
			);

			expect(present).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				ok: false,
				error: { code: "invalid_request" },
			});
		}
	});

	it("carries one exact SSH backend target into structured presentation", async () => {
		const present = vi.fn(async () => ({ ok: true }));
		const result = await handleCliStructuredRunPresentation(
			{
				...request(),
				backendProfileId: "remote-a",
				source: "ssh",
				hostId: "remote-a",
				remote: { host: "dev.example.test", port: 2222, user: "dev" },
				projectPath: "/srv/repo",
			},
			"request-remote-1",
			{ claim: async () => true, present, presentBackground: vi.fn() },
		);

		expect(result).toEqual({ ok: true });
		expect(present).toHaveBeenCalledWith(
			expect.objectContaining({ backendProfileId: "remote-a" }),
			expect.objectContaining({
				projectPath: "/srv/repo",
				executionTarget: {
					source: "ssh",
					hostId: "remote-a",
					remote: { host: "dev.example.test", port: 2222, user: "dev" },
				},
			}),
		);
	});
});

it("projects a background Run without selecting or opening a Space", async () => {
	const { spaceId: _space, ...background } = request();
	const present = vi.fn();
	const presentBackground = vi.fn(
		async () => ({ id: "agent-1" }) as import("@/types").Agent,
	);
	const result = await handleCliStructuredRunPresentation(
		{ ...background, presentation: "background" },
		"background-run",
		{
			claim: async () => true,
			present,
			presentBackground,
		},
	);
	expect(result).toMatchObject({
		ok: true,
		agent: { agentId: "agent-1", interactionSessionId: "interaction-1" },
	});
	expect(present).not.toHaveBeenCalled();
	expect(presentBackground).toHaveBeenCalledOnce();
});
