import { describe, expect, it } from "vitest";
import { persist } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import { DurableWriteCoordinator } from "@/lib/persistence/durableWriteCoordinator";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";
import type { AppStats } from "@/lib/settings/notifyPrefs";
import type {
	AccountProfile,
	Agent,
	AgentActivity,
	Project,
	Provider,
	SshHostConfig,
} from "@/types";
import {
	createAgentRegistrationActions,
	createAgentRegistryStoreSlice,
} from "./agentRegistryStoreSlice";

/** Minimal host harness that applies updater patches the way Zustand does. */
function harness(afterCommit?: () => void) {
	const set: Parameters<typeof createAgentRegistryStoreSlice>[0] = (
		updater,
	) => {
		const next = updater(host.state);
		if (next === host.state) {
			host.noops += 1;
			return;
		}
		host.state = { ...host.state, ...next };
	};
	const slice: ReturnType<typeof createAgentRegistryStoreSlice> &
		ReturnType<typeof createAgentRegistrationActions> = {
		...createAgentRegistryStoreSlice(set),
		...createAgentRegistrationActions(
			set,
			() => host.state,
			async (agent) => {
				host.state = {
					...host.state,
					agents: [...host.state.agents, agent],
					stats: {
						...host.state.stats,
						agentsStarted: host.state.stats.agentsStarted + 1,
					},
				};
				if (afterCommit) queueMicrotask(afterCommit);
				return agent;
			},
		),
	};
	const host = {
		noops: 0,
		state: {
			...slice,
			projects: [] as Project[],
			sshHosts: [] as SshHostConfig[],
			accounts: [] as AccountProfile[],
			activeAccounts: {} as Partial<Record<Provider, string>>,
			stats: { agentsStarted: 0, prsCreated: 0, activeMs: 0, since: 0 },
			agentActivity: {},
		} as typeof slice & {
			projects: Project[];
			sshHosts: SshHostConfig[];
			accounts: AccountProfile[];
			activeAccounts: Partial<Record<Provider, string>>;
			agentActivity: Record<string, AgentActivity>;
			stats: AppStats;
		},
	};
	return host;
}

const project = (id: string): Project => ({
	id,
	name: id,
	path: `/repo/${id}`,
	kind: "local",
	isRepo: true,
});

describe("agentRegistryStoreSlice", () => {
	it("does not recreate activity when removal wins the commit acknowledgement gap", async () => {
		const host = harness(() => {
			host.state.agents = [];
		});
		host.state.projects = [project("p1")];
		await expect(
			host.state.addAgent({
				projectId: "p1",
				name: "removed",
				provider: "claude",
				useWorktree: false,
			}),
		).rejects.toThrow("changed before launch");
		expect(host.state.agents).toEqual([]);
		expect(host.state.agentActivity).toEqual({});
	});
	it.each(["add", "adopt"] as const)(
		"does not acknowledge %s before its registration is durable",
		async (operation) => {
			const bytes = new Map<string, string>([
				["agent-ide", JSON.stringify({ state: { agents: [] }, version: 8 })],
			]);
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const storage = createReferenceAwareLocalStorage<{ agents: Agent[] }>({
				storage: {
					getItem: (key) => bytes.get(key) ?? null,
					setItem: (key, value) => {
						bytes.set(key, value);
					},
					removeItem: (key) => {
						bytes.delete(key);
					},
				},
				coordinator: new DurableWriteCoordinator({
					request: async (_name, write) => {
						await held;
						return write();
					},
				}),
			});
			type Host = ReturnType<typeof harness>["state"];
			const registry = createStore<Host>()(
				persist(
					(set, get) => ({
						...harness().state,
						...createAgentRegistryStoreSlice(set),
						...createAgentRegistrationActions(set, get, async (agent) => {
							await storage.transact("agent-ide", (current) => ({
								value: {
									version: 8,
									state: { agents: [...(current?.state.agents ?? []), agent] },
								},
								result: undefined,
							}));
							await registry.persist.rehydrate();
							return agent;
						}),
						projects: [project("p1")],
					}),
					{
						name: "agent-ide",
						version: 8,
						storage,
						partialize: (state) => ({ agents: state.agents }),
					},
				),
			);
			let acknowledged = false;
			const registration = (
				operation === "add"
					? registry.getState().addAgent({
							projectId: "p1",
							name: "durability",
							provider: "claude",
							useWorktree: false,
						})
					: registry.getState().adoptAgent({
							projectId: "p1",
							provider: "claude",
							worktreePath: "/repo/p1",
							branch: "main",
						})
			).then((agent) => {
				acknowledged = true;
				return agent;
			});
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(JSON.parse(bytes.get("agent-ide")!).state.agents).toEqual([]);
				expect(acknowledged).toBe(false);
				expect(registry.getState().agents).toEqual([]);
			} finally {
				release();
				const agent = await registration;
				await storage.flush();
				expect(
					JSON.parse(bytes.get("agent-ide")!).state.agents.map(
						(value: Agent) => value.id,
					),
				).toEqual([agent.id]);
			}
		},
	);

	it("addAgent는 모르는 프로젝트면 던지고 아무것도 등록하지 않는다", async () => {
		const host = harness();
		await expect(
			host.state.addAgent({
				projectId: "ghost",
				name: "a",
				provider: "claude",
				useWorktree: false,
			}),
		).rejects.toThrow();
		expect(host.state.agents).toEqual([]);
		expect(host.state.stats.agentsStarted).toBe(0);
	});

	it("addAgent(워크트리 없음)는 등록·connecting 활동·통계 증가를 한 번에 커밋한다", async () => {
		const host = harness();
		host.state.projects = [project("p1")];
		const agent = await host.state.addAgent({
			projectId: "p1",
			name: "worker",
			provider: "claude",
			useWorktree: false,
		});
		expect(agent.worktreePath).toBe("/repo/p1");
		expect(host.state.agents).toEqual([agent]);
		expect(host.state.agentActivity[agent.id]).toBe("connecting");
		expect(host.state.stats.agentsStarted).toBe(1);
	});

	it("adoptAgent는 기본으로 세션 이어받기(started)로 시작하고 resume:false면 새 대화로 시작한다", async () => {
		const host = harness();
		host.state.projects = [project("p1")];
		const adopted = await host.state.adoptAgent({
			projectId: "p1",
			provider: "codex",
			worktreePath: "/repo/p1/.worktrees/x",
			branch: "x",
		});
		expect(adopted.started).toBe(true);
		expect(adopted.runtimeBinding?.runtime).toBe("hmux_managed_v1");
		const fresh = await host.state.adoptAgent({
			projectId: "p1",
			provider: "codex",
			worktreePath: "/repo/p1/.worktrees/y",
			branch: "y",
			resume: false,
		});
		expect(fresh.started).toBe(false);
		expect(host.state.stats.agentsStarted).toBe(2);
	});
});
