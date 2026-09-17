import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	local: vi.fn(),
	remote: vi.fn(),
}));

vi.mock("@/lib/sessions/managed/managedAgentRuntime", () => ({
	ensureManagedAgentRuntime: mocks.local,
}));
vi.mock("@/lib/sessions/launch/remoteManagedAgentRuntime", () => ({
	ensureRemoteManagedAgentRuntime: mocks.remote,
}));

import { beginManagedRuntimeEnsure } from "@/lib/sessions/launch/managedRuntimeEnsure";

function agent(source: "local" | "ssh"): Agent {
	return {
		id: "agent-1",
		name: "codex-1",
		provider: "codex",
		projectId: "project-1",
		worktreePath: source === "local" ? "/repo" : "/srv/repo",
		branch: "",
		sessionId: "agent-1",
		sessionKind: source === "local" ? "pty" : "ssh",
		runtimeBinding:
			source === "local"
				? {
						schemaVersion: 1,
						runtime: "hmux_managed_v1",
						source,
						hostId: "local",
						sessionId: "agent-1",
						workspaceId: "project-1",
					}
				: {
						schemaVersion: 1,
						runtime: "hmux_managed_v1",
						source,
						hostId: "host-1",
						sessionId: "agent-1",
						workspaceId: "project-1",
						createIdempotencyKey: "create-1",
						commandBridgeNonce: "bridge-1",
					},
	};
}

describe("managed runtime ensure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.local.mockResolvedValue({
			agent: agent("local"),
			session: { sessionId: "local-session", workspaceId: "local-workspace" },
			idempotencyKey: "local-create",
			cwd: "/repo",
		});
		mocks.remote.mockResolvedValue({
			agent: agent("ssh"),
			sessionId: "remote-session",
			workspaceId: "remote-workspace",
			idempotencyKey: "remote-create",
		});
	});

	it("routes each binding once and normalizes only shared Host identity", async () => {
		const options = { columns: 120, rows: 30 };
		const localAgent = agent("local");
		const remoteAgent = agent("ssh");

		const local = beginManagedRuntimeEnsure(localAgent, options);
		const remote = beginManagedRuntimeEnsure(remoteAgent, options);

		expect(local?.source).toBe("local");
		expect(remote?.source).toBe("ssh");
		await expect(local?.receipt).resolves.toEqual({
			agent: agent("local"),
			sessionId: "local-session",
			workspaceId: "local-workspace",
			idempotencyKey: "local-create",
			confirmedCwd: "/repo",
		});
		await expect(remote?.receipt).resolves.toEqual({
			agent: agent("ssh"),
			sessionId: "remote-session",
			workspaceId: "remote-workspace",
			idempotencyKey: "remote-create",
		});
		expect(mocks.local).toHaveBeenCalledWith(localAgent, options);
		expect(mocks.remote).toHaveBeenCalledWith(remoteAgent, options);
	});

	it("has no fallback creator for an unbound Agent", () => {
		const unbound = { ...agent("local"), runtimeBinding: undefined };

		expect(
			beginManagedRuntimeEnsure(unbound, { columns: 120, rows: 30 }),
		).toBeUndefined();
		expect(mocks.local).not.toHaveBeenCalled();
		expect(mocks.remote).not.toHaveBeenCalled();
	});

	it("rejects an unknown managed source instead of silently skipping create", () => {
		const unsupported = {
			...agent("local"),
			runtimeBinding: {
				...agent("local").runtimeBinding,
				source: "container",
			},
		} as unknown as Agent;

		expect(() =>
			beginManagedRuntimeEnsure(unsupported, { columns: 120, rows: 30 }),
		).toThrow("unsupported managed runtime source: container");
		expect(mocks.local).not.toHaveBeenCalled();
		expect(mocks.remote).not.toHaveBeenCalled();
	});
});
