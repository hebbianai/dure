import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { hmux } from "@/lib/ipc/hmux";

beforeEach(() => {
	mocks.invoke.mockReset();
});

describe("Hmux existing-writer launch reference boundary", () => {
	it("keeps the legacy credentialId wire name out of frontend authority", async () => {
		mocks.invoke.mockResolvedValue({
			session: { sessionId: "session-final", workspaceId: "workspace-1" },
			idempotencyKey: "create-final",
			conversationId: "conversation-2",
			credentialId: "opaque+provider-reference",
			permissionMode: "default",
		});

		const result = await hmux.inspectExistingManagedWriter({
			sessionId: "session-final",
			workspaceId: "workspace-1",
			providerId: "codex",
			conversationId: "conversation-2",
			cwd: "/repo/worktree",
			permissionMode: "default",
			launchReference: "opaque+provider-reference",
		});

		expect(mocks.invoke).toHaveBeenCalledWith("hmux_existing_managed_writer", {
			request: {
				sessionId: "session-final",
				workspaceId: "workspace-1",
				providerId: "codex",
				conversationId: "conversation-2",
				cwd: "/repo/worktree",
				permissionMode: "default",
				credentialId: "opaque+provider-reference",
			},
		});
		expect(result).toMatchObject({
			launchReference: "opaque+provider-reference",
		});
		expect(result).not.toHaveProperty("credentialId");
	});
});
