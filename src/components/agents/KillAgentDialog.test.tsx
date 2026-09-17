// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  gitStatus: vi.fn(),
}));
vi.mock("@/lib/agents/resourceLifecycle", () => {
	class AgentRemovalScopeChangedError extends Error {
		constructor(readonly retry: "reprepare" | "same_operation") {
			super("agents.remove.worktreeUsersChanged");
		}
	}
	class AgentRemovalWorktreeUnsupportedError extends Error {
		constructor(readonly preview: unknown) {
			super("agents.remove.impactUnverified");
		}
	}
	return {
		AgentRemovalScopeChangedError,
		AgentRemovalWorktreeUnsupportedError,
	executeAgentRemoval: vi.fn(),
	prepareAgentRemoval: vi.fn(),
	};
});

import { KillAgentDialog } from "@/components/agents/KillAgentDialog";
import {
	agentRemovalRegistrationIdentity,
	sameAgentRemovalTarget,
} from "@/lib/agents/agentRemovalRegistration";
import { CanonicalAgentStopRetainedError } from "@/lib/agents/canonicalAgentStopRuntime";
import {
	AgentRemovalScopeChangedError,
	AgentRemovalWorktreeUnsupportedError,
	executeAgentRemoval,
	type PreparedAgentRemoval,
	prepareAgentRemoval,
} from "@/lib/agents/resourceLifecycle";
import { gitStatus } from "@/lib/ipc";
import { useStore } from "@/store";
import type { Agent } from "@/types";

const dedicatedAgent: Agent = {
  id: "agent-1",
  name: "agent-1",
  provider: "codex",
  projectId: "project-1",
  worktreePath: "/repo/.worktrees/agent-1",
  branch: "agent/agent-1",
  sessionId: "session-1",
  sessionKind: "pty",
};

const sharedAgent: Agent = {
  ...dedicatedAgent,
  id: "agent-2",
  name: "claude-review",
  provider: "claude",
  branch: "agent/claude-review",
  sessionId: "session-2",
};

beforeEach(() => {
  vi.mocked(gitStatus).mockResolvedValue({
    isRepo: true,
    branch: "agent/agent-1",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
  });
	vi.mocked(prepareAgentRemoval).mockImplementation(
		async (_agentId, options): Promise<PreparedAgentRemoval> => ({
			preview: {
				agents: [dedicatedAgent],
				...(options.deleteWorktree
					? {
							worktree: {
								kind: "local" as const,
								repo: "/repo",
								wtPath: dedicatedAgent.worktreePath,
							},
						}
					: {}),
			},
		}),
	);
	vi.mocked(executeAgentRemoval).mockResolvedValue({
		agentIds: [dedicatedAgent.id],
	});
  useStore.setState({
    agents: [dedicatedAgent],
    projects: [
      {
        id: "project-1",
        name: "Project",
        path: "/repo",
        kind: "local",
        isRepo: true,
      },
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("KillAgentDialog", () => {
	it("finishes agent removal without a disk step when the worktree is already absent", async () => {
		vi.mocked(prepareAgentRemoval).mockResolvedValueOnce({ preview: {
			agents: [dedicatedAgent],
			worktree: { kind: "local", repo: "/repo", wtPath: dedicatedAgent.worktreePath },
			worktreeAlreadyAbsent: true,
		} });
		render(<KillAgentDialog agent={dedicatedAgent} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("switch"));
		fireEvent.click(screen.getByRole("button", { name: "제거" }));
		await waitFor(() => expect(screen.getByText("1/1 · 완료")).toBeTruthy());
		expect(screen.getByText("워크트리가 이미 없습니다. 선택한 에이전트와 세션만 제거합니다.")).toBeTruthy();
		expect(executeAgentRemoval).toHaveBeenCalledOnce();
	});
	it("refreshes a replaced target before retrying its deletion", async () => {
		const replacement = {
			...dedicatedAgent,
			name: "replacement",
			sessionId: "replacement-session",
			worktreePath: "/repo/.worktrees/replacement",
		};
		vi.mocked(prepareAgentRemoval).mockImplementation(async (_id, options) => {
			if (!options.expectedIdentity || !sameAgentRemovalTarget(replacement, options.expectedIdentity)) {
				throw new AgentRemovalScopeChangedError("reprepare");
			}
			return { preview: { agents: [replacement], worktree: {
				kind: "local", repo: "/repo", wtPath: replacement.worktreePath,
			} } };
		});
		render(<KillAgentDialog agent={dedicatedAgent} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("switch"));
		useStore.setState({ agents: [replacement] });
		fireEvent.click(screen.getByRole("button", { name: "제거" }));
		await waitFor(() => expect(screen.getByText(replacement.worktreePath)).toBeTruthy());
		expect(executeAgentRemoval).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "제거" }));
		await waitFor(() => expect(executeAgentRemoval).toHaveBeenCalledOnce());
		expect(prepareAgentRemoval).toHaveBeenLastCalledWith(replacement.id, {
			deleteWorktree: true, expectedIdentity: agentRemovalRegistrationIdentity(replacement),
		});
	});
	it.each(["source_retained", "superseded", "authorized"] as const)(
		"retries %s with a fresh plan only for a definitive refusal",
		async (status) => {
			const canonical = {
				...dedicatedAgent,
				canonicalSpawn: {
					schemaVersion: 1 as const,
					backendProfileId: "local",
					operationId: "spawn-1",
				},
			};
			useStore.setState({ agents: [canonical] });
			vi.mocked(executeAgentRemoval).mockRejectedValueOnce(
				new CanonicalAgentStopRetainedError({
					schemaVersion: 1,
					operationId: "stop-1",
					spawnOperationId: "spawn-1",
					agentId: canonical.id,
					planToken: `sha256:${"a".repeat(64)}`,
					journalRevision: 3,
					workspaceDisposition: "preserve",
					status,
				}),
			);
			render(<KillAgentDialog agent={canonical} onClose={vi.fn()} />);
			fireEvent.click(screen.getByRole("button", { name: "제거" }));
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "제거" }).hasAttribute("disabled"),
				).toBe(false),
			);
			expect(executeAgentRemoval).toHaveBeenCalledOnce();
			expect(prepareAgentRemoval).toHaveBeenCalledOnce();

			fireEvent.click(screen.getByRole("button", { name: "제거" }));
			await waitFor(() => expect(executeAgentRemoval).toHaveBeenCalledTimes(2));
			expect(prepareAgentRemoval).toHaveBeenCalledTimes(
				status === "authorized" ? 1 : 2,
			);
			expect(prepareAgentRemoval).toHaveBeenLastCalledWith(canonical.id, {
				deleteWorktree: false,
				expectedIdentity: agentRemovalRegistrationIdentity(canonical),
			});
			const attempts = vi.mocked(executeAgentRemoval).mock.calls;
			expect(attempts[0]?.[0] === attempts[1]?.[0]).toBe(
				status === "authorized",
			);
		},
	);

  it("lets a pane removal include its dedicated worktree", async () => {
    render(<KillAgentDialog agent={dedicatedAgent} onClose={vi.fn()} />);

    const worktreeSwitch = screen.getByRole("switch", {
      name: /전용 워크트리도 디스크에서 삭제/,
    });
    expect(worktreeSwitch.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByText(dedicatedAgent.worktreePath)).toBeTruthy();

    fireEvent.click(worktreeSwitch);
    fireEvent.click(screen.getByRole("button", { name: "제거" }));

    await waitFor(() =>
			expect(prepareAgentRemoval).toHaveBeenCalledWith(dedicatedAgent.id, {
        deleteWorktree: true,
				expectedIdentity: agentRemovalRegistrationIdentity(dedicatedAgent),
      }),
    );
		expect(executeAgentRemoval).toHaveBeenCalledWith(
			expect.objectContaining({ preview: expect.any(Object) }),
			{ onProgress: expect.any(Function) },
		);
  });

  it("does not offer worktree deletion for an agent using the project root", async () => {
    const rootAgent = {
      ...dedicatedAgent,
      branch: "",
      worktreePath: "/repo",
    };
    render(<KillAgentDialog agent={rootAgent} onClose={vi.fn()} />);

    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "제거" }));

    await waitFor(() =>
			expect(prepareAgentRemoval).toHaveBeenCalledWith(rootAgent.id, {
        deleteWorktree: false,
				expectedIdentity: agentRemovalRegistrationIdentity(rootAgent),
      }),
    );
  });

	it("does not expose worktree deletion for a canonical Agent", async () => {
		const canonical = {
			...dedicatedAgent,
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		};
		render(<KillAgentDialog agent={canonical} onClose={vi.fn()} />);

		expect(screen.queryByRole("switch")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "제거" }));

		await waitFor(() =>
			expect(prepareAgentRemoval).toHaveBeenCalledWith(canonical.id, {
				deleteWorktree: false,
				expectedIdentity: agentRemovalRegistrationIdentity(canonical),
			}),
		);
	});

	it("shows only the selected Agent until Host preparation resolves aliases", () => {
    useStore.setState({ agents: [dedicatedAgent, sharedAgent] });
    render(<KillAgentDialog agent={dedicatedAgent} onClose={vi.fn()} />);

    fireEvent.click(
      screen.getByRole("switch", {
        name: /전용 워크트리도 디스크에서 삭제/,
      }),
    );

    expect(
			screen.getByText("이 워크트리와 아래 에이전트 1개를 함께 제거합니다."),
    ).toBeTruthy();
    expect(screen.getAllByText("agent-1").length).toBeGreaterThan(0);
		expect(screen.queryByText("claude-review")).toBeNull();
	});

	it("shows a changed prepared scope before requiring confirmation again", async () => {
		const expandedOperation: PreparedAgentRemoval = {
			preview: {
				agents: [sharedAgent, dedicatedAgent],
				worktree: {
					kind: "local",
					repo: "/repo",
					wtPath: dedicatedAgent.worktreePath,
				},
			},
		};
		vi.mocked(prepareAgentRemoval).mockResolvedValueOnce(expandedOperation);
		render(<KillAgentDialog agent={dedicatedAgent} onClose={vi.fn()} />);

		fireEvent.click(
			screen.getByRole("switch", {
				name: /전용 워크트리도 디스크에서 삭제/,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "제거" }));

		await waitFor(() =>
			expect(
				screen.getByText(
					"삭제 대상 정보가 바뀌었습니다. 갱신된 대상을 확인하고 제거를 다시 눌러 주세요.",
				),
			).toBeTruthy(),
		);
    expect(screen.getByText("claude-review")).toBeTruthy();
		expect(executeAgentRemoval).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "제거" }));
		await waitFor(() =>
			expect(executeAgentRemoval).toHaveBeenCalledWith(expandedOperation, {
				onProgress: expect.any(Function),
			}),
		);
		expect(prepareAgentRemoval).toHaveBeenCalledOnce();
  });

	it("shows canonical co-users while refusing raw worktree deletion", async () => {
		const canonical = {
			...sharedAgent,
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		};
		const preview = {
			agents: [canonical, dedicatedAgent],
			worktree: {
				kind: "local" as const,
				repo: "/repo",
				wtPath: dedicatedAgent.worktreePath,
			},
		};
		vi.mocked(prepareAgentRemoval).mockRejectedValue(
			new AgentRemovalWorktreeUnsupportedError(preview),
		);
		render(<KillAgentDialog agent={dedicatedAgent} onClose={vi.fn()} />);

		fireEvent.click(screen.getByRole("switch"));
		fireEvent.click(screen.getByRole("button", { name: "제거" }));

		await waitFor(() => expect(screen.getByText("claude-review")).toBeTruthy());
		expect(executeAgentRemoval).not.toHaveBeenCalled();
	});

	it("delegates ambiguous Agent paths to canonical Host preparation", async () => {
    useStore.setState({
			agents: [
				dedicatedAgent,
				{ ...sharedAgent, projectId: "missing-project" },
			],
    });
    render(<KillAgentDialog agent={dedicatedAgent} onClose={vi.fn()} />);

    const worktreeSwitch = screen.getByRole("switch", {
      name: /전용 워크트리도 디스크에서 삭제/,
    });
		expect(worktreeSwitch.hasAttribute("disabled")).toBe(false);

		fireEvent.click(worktreeSwitch);
    fireEvent.click(screen.getByRole("button", { name: "제거" }));
    await waitFor(() =>
			expect(prepareAgentRemoval).toHaveBeenCalledWith(dedicatedAgent.id, {
				deleteWorktree: true,
				expectedIdentity: agentRemovalRegistrationIdentity(dedicatedAgent),
			}),
		);
	});

	it("keeps the rendered Agent identity when a no-worktree removal is prepared", async () => {
		const rootAgent = {
			...dedicatedAgent,
			branch: "",
			worktreePath: "/repo",
		};
		vi.mocked(prepareAgentRemoval).mockRejectedValueOnce(
			new Error("agents.remove.worktreeUsersChanged"),
		);
		render(<KillAgentDialog agent={rootAgent} onClose={vi.fn()} />);
		useStore.setState({
			agents: [{ ...rootAgent, sessionId: "replacement-session" }],
		});

		fireEvent.click(screen.getByRole("button", { name: "제거" }));

		await waitFor(() =>
			expect(prepareAgentRemoval).toHaveBeenCalledWith(rootAgent.id, {
        deleteWorktree: false,
				expectedIdentity: agentRemovalRegistrationIdentity(rootAgent),
      }),
    );
		expect(executeAgentRemoval).not.toHaveBeenCalled();
  });

  it("keeps progress visible after the target registration disappears", async () => {
    const onClose = vi.fn();
    let finishWorktree: (() => void) | undefined;
    const worktreePending = new Promise<void>((resolve) => {
      finishWorktree = resolve;
    });
		vi.mocked(executeAgentRemoval).mockImplementation(
			async (_operation, options) => {
      options?.onProgress?.({
        kind: "agent",
        agentId: dedicatedAgent.id,
        status: "started",
      });
      useStore.setState({ agents: [] });
      options?.onProgress?.({
        kind: "worktree",
        path: dedicatedAgent.worktreePath,
        status: "started",
      });
      await worktreePending;
      options?.onProgress?.({
        kind: "worktree",
        path: dedicatedAgent.worktreePath,
        status: "completed",
      });
				options?.onProgress?.({
					kind: "agent",
					agentId: dedicatedAgent.id,
					status: "completed",
    });
				return { agentIds: [dedicatedAgent.id] };
			},
		);

    render(<KillAgentDialog agent={dedicatedAgent} onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("switch", {
        name: /전용 워크트리도 디스크에서 삭제/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "제거" }));

		await waitFor(() =>
			expect(screen.getByText("0/2 · 제거 중…")).toBeTruthy(),
		);
		expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
		fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getAllByText("agent-1").length).toBeGreaterThan(0);
    expect(onClose).not.toHaveBeenCalled();

    finishWorktree?.();

    await waitFor(() => expect(screen.getByText("2/2 · 완료")).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("닫기", { selector: "button" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

	it("reports the Agent removed when optional worktree cleanup fails", async () => {
		vi.mocked(executeAgentRemoval).mockImplementation(
			async (_operation, options) => {
				options?.onProgress?.({
					kind: "agent",
					agentId: dedicatedAgent.id,
					status: "started",
				});
				options?.onProgress?.({
					kind: "worktree",
					path: dedicatedAgent.worktreePath,
					status: "started",
				});
				options?.onProgress?.({
					kind: "agent",
					agentId: dedicatedAgent.id,
					status: "completed",
				});
				throw new Error("dirty checkout was preserved");
			},
		);
		render(<KillAgentDialog agent={dedicatedAgent} onClose={vi.fn()} />);
		fireEvent.click(
			screen.getByRole("switch", {
				name: /전용 워크트리도 디스크에서 삭제/,
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "제거" }));

		await waitFor(() =>
			expect(screen.getByText("dirty checkout was preserved")).toBeTruthy(),
		);
		expect(screen.getByText("1/2 · 실패")).toBeTruthy();
		expect(screen.getByText("완료")).toBeTruthy();
		expect(screen.getByText("실패")).toBeTruthy();
	});

	it("retries finalization with the same prepared operation after registration loss", async () => {
    const onClose = vi.fn();
		let attempt = 0;
		vi.mocked(executeAgentRemoval).mockImplementation(
			async (_operation, options) => {
				attempt += 1;
				if (attempt === 1) {
      options?.onProgress?.({
        kind: "agent",
        agentId: dedicatedAgent.id,
        status: "started",
      });
      options?.onProgress?.({
						kind: "worktree",
						path: dedicatedAgent.worktreePath,
						status: "started",
      });
      options?.onProgress?.({
        kind: "worktree",
        path: dedicatedAgent.worktreePath,
						status: "completed",
      });
					useStore.setState({ agents: [] });
					throw new Error("finalization failed");
				}
				options?.onProgress?.({
					kind: "agent",
					agentId: dedicatedAgent.id,
					status: "completed",
    });
				return { agentIds: [dedicatedAgent.id] };
			},
		);

    render(<KillAgentDialog agent={dedicatedAgent} onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("switch", {
        name: /전용 워크트리도 디스크에서 삭제/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "제거" }));

		await waitFor(() =>
			expect(screen.getByText("finalization failed")).toBeTruthy(),
		);
    expect(screen.getByText("실패")).toBeTruthy();
		const retry = screen.getByRole("button", { name: "제거" });
		expect(
			screen
				.getByRole("switch", {
					name: /전용 워크트리도 디스크에서 삭제/,
				})
				.hasAttribute("disabled"),
		).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

		fireEvent.click(retry);
		await waitFor(() => expect(screen.getByText("2/2 · 완료")).toBeTruthy());
		expect(prepareAgentRemoval).toHaveBeenCalledOnce();
		expect(executeAgentRemoval).toHaveBeenCalledTimes(2);
		expect(vi.mocked(executeAgentRemoval).mock.calls[0]?.[0]).toBe(
			vi.mocked(executeAgentRemoval).mock.calls[1]?.[0],
		);
    fireEvent.click(screen.getByText("닫기", { selector: "button" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

	it("reprepares a stale operation when no destructive step began", async () => {
		vi.mocked(executeAgentRemoval)
			.mockRejectedValueOnce(new AgentRemovalScopeChangedError("reprepare"))
			.mockResolvedValueOnce({ agentIds: [dedicatedAgent.id] });
		render(<KillAgentDialog agent={dedicatedAgent} onClose={vi.fn()} />);
		fireEvent.click(
			screen.getByRole("switch", {
				name: /전용 워크트리도 디스크에서 삭제/,
			}),
		);

		fireEvent.click(screen.getByRole("button", { name: "제거" }));
		await waitFor(() =>
			expect(
				screen.getByText(
					"워크트리를 사용하는 에이전트가 변경되어 디스크 삭제를 중단했습니다.",
				),
			).toBeTruthy(),
		);

		fireEvent.click(screen.getByRole("button", { name: "제거" }));
		await waitFor(() => expect(executeAgentRemoval).toHaveBeenCalledTimes(2));
		expect(prepareAgentRemoval).toHaveBeenCalledTimes(2);
	});
});
