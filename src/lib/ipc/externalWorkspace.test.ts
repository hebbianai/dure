import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	externalWorkspaceTargets,
	openExternalFileNative,
	openExternalWorkspaceNative,
} from "./externalWorkspace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
	invokeMock.mockReset();
});

describe("external workspace IPC boundary", () => {
	it("normalizes a malformed catalog response into an asynchronous rejection", async () => {
		invokeMock.mockReturnValue(undefined as never);

		await expect(externalWorkspaceTargets(true)).rejects.toThrow(
			"external workspace target catalog is invalid",
		);
	});

	it("accepts a receipt bound to the requested target", async () => {
		invokeMock.mockResolvedValue({
			schemaVersion: 1,
			targetId: "cursor",
			canonicalPath: "/repo/.worktrees/agent-1",
			attemptedCandidates: 1,
		});

		await expect(
			openExternalWorkspaceNative("/repo/.worktrees/agent-1", "cursor"),
		).resolves.toMatchObject({ targetId: "cursor", attemptedCandidates: 1 });
	});

	it("rejects a receipt that changes the requested target identity", async () => {
		invokeMock.mockResolvedValue({
			schemaVersion: 1,
			targetId: "finder",
			canonicalPath: "/repo/.worktrees/agent-1",
			attemptedCandidates: 1,
		});

		await expect(
			openExternalWorkspaceNative("/repo/.worktrees/agent-1", "cursor"),
		).rejects.toMatchObject({ code: "external_response_invalid" });
	});

	it("asks the native launcher for the declared subject", async () => {
		invokeMock.mockImplementation(async (_command, args) => ({
			schemaVersion: 1,
			targetId: (args as { targetId: string }).targetId,
			canonicalPath: (args as { path: string }).path,
			attemptedCandidates: 1,
		}));

		await openExternalWorkspaceNative("/repo", "finder");
		await openExternalFileNative("/notes/gallery.md", "cursor");

		expect(invokeMock.mock.calls).toEqual([
			[
				"open_external_workspace",
				{ path: "/repo", targetId: "finder", subject: "workspace" },
			],
			[
				"open_external_workspace",
				{ path: "/notes/gallery.md", targetId: "cursor", subject: "file" },
			],
		]);
	});
});
