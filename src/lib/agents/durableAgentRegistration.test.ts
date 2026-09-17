// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addAgent, adoptAgent } from "@/lib/agents/agentRegistration";
import { normalizePersistedState } from "@/lib/persistence/persistedAppState";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
	rehydrateAppStoreFromDurableStorage,
	useStore,
} from "@/store";
import type { Agent, Project } from "@/types";
import { buildInitialAgentRegistration } from "./agentLaunchCredential";
import { registerAgentDurably } from "./durableAgentRegistration";

const projection = vi.hoisted(() => ({
	before: undefined as (() => Promise<void>) | undefined,
	fail: false,
}));
vi.mock(
	"@/lib/persistence/currentDurableProjectionRecovery",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/persistence/currentDurableProjectionRecovery")
		>()),
		recoverCurrentDurableStoreProjection: async () => {
			await projection.before?.();
			if (projection.fail) return false;
			const original =
				await importOriginal<
					typeof import("@/lib/persistence/currentDurableProjectionRecovery")
				>();
			return original.recoverCurrentDurableStoreProjection();
		},
	}),
);

const project: Project = {
	id: "project-qa",
	name: "QA",
	path: "/qa",
	kind: "local",
	isRepo: true,
};
const agent = (id: string): Agent =>
	buildInitialAgentRegistration({
		id,
		name: id,
		project,
		provider: "claude",
		worktreePath: project.path,
		branch: "main",
		credential: {},
	});
async function replaceProjects(projects: Project[]) {
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => ({
		value: {
			version: PERSIST_VERSION,
			state: { ...normalizePersistedState(current?.state ?? {}), projects },
		},
		result: undefined,
	}));
}
async function durableAgents() {
	return durableAppStorage.read(
		DURABLE_APP_STORE_NAME,
		(current) => current?.state.agents ?? [],
	);
}

beforeEach(async () => {
	projection.before = undefined;
	projection.fail = false;
	await durableAppStorage.flush();
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, () => ({
		value: {
			version: PERSIST_VERSION,
			state: { ...normalizePersistedState({}), projects: [project] },
		},
		result: undefined,
	}));
	await rehydrateAppStoreFromDurableStorage();
});

describe("durable agent registration", () => {
	it("does not acknowledge a durable registration when projection recovery fails", async () => {
		projection.fail = true;
		await expect(
			addAgent({
				projectId: project.id,
				name: "projection-failure",
				provider: "claude",
				useWorktree: false,
			}),
		).rejects.toThrow("projection failed");
		expect(await durableAgents()).toHaveLength(1);
		expect(useStore.getState().agents).toEqual([]);
	});
	it("orders a newly queued project before production addAgent", async () => {
		const nextProject = { ...project, id: "new-project", path: "/new-project" };
		useStore.setState((state) => ({
			projects: [...state.projects, nextProject],
		}));
		const registered = await addAgent({
			projectId: nextProject.id,
			name: "new",
			provider: "claude",
			useWorktree: false,
		});
		expect((await durableAgents()).map((value) => value.id)).toEqual([
			registered.id,
		]);
		expect(useStore.getState().agents.map((value) => value.id)).toEqual([
			registered.id,
		]);
	});
	it.each(["add", "adopt"] as const)(
		"holds production %s until the real writer commits",
		async (operation) => {
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const request = navigator.locks.request.bind(navigator.locks);
			const lock = vi
				.spyOn(navigator.locks, "request")
				.mockImplementation((...args: Parameters<typeof request>) =>
					held.then(() => request(...args)),
				);
			let acknowledged = false;
			const registration = (
				operation === "add"
					? addAgent({
							projectId: project.id,
							name: "held",
							provider: "claude",
							useWorktree: false,
						})
					: adoptAgent({
							projectId: project.id,
							provider: "claude",
							worktreePath: project.path,
							branch: "main",
						})
			).then((value) => {
				acknowledged = true;
				return value;
			});
			try {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				expect(acknowledged).toBe(false);
				expect(useStore.getState().agents).toEqual([]);
				expect(
					JSON.parse(localStorage.getItem(DURABLE_APP_STORE_NAME)!).state
						.agents,
				).toEqual([]);
			} finally {
				release();
				lock.mockRestore();
			}
			const registered = await registration;
			expect((await durableAgents()).map((value) => value.id)).toEqual([
				registered.id,
			]);
		},
	);
	it("preserves concurrent registrations and increments durable stats exactly once", async () => {
		await Promise.all([
			registerAgentDurably(agent("a"), project),
			registerAgentDurably(agent("b"), project),
		]);
		expect((await durableAgents()).map((value) => value.id)).toEqual([
			"a",
			"b",
		]);
		expect(useStore.getState().agents.map((value) => value.id)).toEqual([
			"a",
			"b",
		]);
		expect(useStore.getState().stats.agentsStarted).toBe(2);
		await expect(registerAgentDurably(agent("a"), project)).rejects.toThrow(
			"already exists",
		);
		expect((await durableAgents()).map((value) => value.id)).toEqual([
			"a",
			"b",
		]);
	});
	it.each([
		{ projects: [] },
		{ projects: [{ ...project, path: "/replacement" }] },
	])("refuses a removed or replaced project", async ({ projects }) => {
		await replaceProjects(projects);
		await expect(registerAgentDurably(agent("a"), project)).rejects.toThrow(
			"project changed",
		);
		expect(await durableAgents()).toEqual([]);
		expect(useStore.getState().agents).toEqual([]);
	});
	it("does not resurrect a registration removed after commit but before projection", async () => {
		projection.before = async () => {
			await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => ({
				value: {
					version: PERSIST_VERSION,
					state: {
						...normalizePersistedState(current?.state ?? {}),
						agents: [],
					},
				},
				result: undefined,
			}));
		};
		await expect(registerAgentDurably(agent("a"), project)).rejects.toThrow(
			"changed before launch",
		);
		expect(await durableAgents()).toEqual([]);
		expect(useStore.getState().agents).toEqual([]);
	});
	it("does not expose an agent when storage rejects the transaction", async () => {
		const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new Error("disk full");
		});
		try {
			await expect(
				addAgent({
					projectId: project.id,
					name: "failed",
					provider: "claude",
					useWorktree: false,
				}),
			).rejects.toThrow("disk full");
			expect(useStore.getState().agents).toEqual([]);
		} finally {
			write.mockRestore();
		}
		expect(await durableAgents()).toEqual([]);
	});
});
