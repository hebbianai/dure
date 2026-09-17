import { describe, expect, it, vi } from "vitest";
import { dispatchCliExternalWorkspaceRequest } from "./cliExternalWorkspace";

describe("CLI external workspace dispatch", () => {
	it("forwards one canonical Space and exact pane to the shared action", async () => {
		const open = vi.fn(async (request) => ({
			schemaVersion: 1 as const,
			targetId: request.targetId ?? "finder",
			canonicalPath: "/repo/.worktrees/agent-1",
			attemptedCandidates: 1,
			spaceId: request.spaceId,
			panelId: request.panelId,
			kind: "agent" as const,
		}));
		const complete = vi.fn(async () => {});

		expect(
			await dispatchCliExternalWorkspaceRequest(
				{
					reqId: "request-1",
					action: "workspace.open-external",
					params: {
						spaceId: "space-1",
						desktopId: "space-1",
						panelId: "agent:agent-1",
						targetId: "cursor",
					},
				},
				{ claim: async () => true, complete, open },
			),
		).toBe(true);
		expect(open).toHaveBeenCalledWith({
			spaceId: "space-1",
			panelId: "agent:agent-1",
			targetId: "cursor",
		});
		expect(complete).toHaveBeenCalledWith(
			"request-1",
			expect.objectContaining({
				ok: true,
				workspace: expect.objectContaining({
					kind: "agent",
					targetId: "cursor",
				}),
			}),
			"workspace.open-external",
		);
	});

	it("publishes a typed action refusal without a second implementation", async () => {
		const complete = vi.fn(async () => {});
		const error = Object.assign(new Error("remote workspace"), {
			code: "workspace_remote",
		});

		await dispatchCliExternalWorkspaceRequest(
			{
				reqId: "request-2",
				action: "workspace.open-external",
				params: { spaceId: "space-1", panelId: "ssh:session-1" },
			},
			{
				claim: async () => true,
				complete,
				open: async () => {
					throw error;
				},
			},
		);

		expect(complete).toHaveBeenCalledWith(
			"request-2",
			{
				ok: false,
				error: { code: "workspace_remote", message: "remote workspace" },
			},
			"workspace.open-external",
		);
	});
});
