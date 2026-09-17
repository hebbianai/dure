import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	externalWorkspaceTargets,
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
});
