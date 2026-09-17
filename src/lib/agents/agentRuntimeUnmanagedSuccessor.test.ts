import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "@/store";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { nativeResumeCreateFixture } from "@/test/managedNativeRehostFixtures";
import { managedRehostAgentFixture } from "@/test/managedRehostFixtures";
import { convergeUnmanagedAgentSuccessor } from "./agentRuntimeUnmanagedSuccessor";

const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	writer: vi.fn(),
	inspect: vi.fn(),
	ensure: vi.fn(),
	selectRoute: vi.fn(),
}));
vi.mock("@/lib/ipc", async (original) => ({
	...(await original<object>()),
	hmux: {
		resolveManagedRehost: mocks.resolve,
		inspectExistingManagedWriter: mocks.writer,
	},
}));
vi.mock("@/lib/ipc/dureAgentRuntime", () => ({
	createDureAgentRuntimeClient: () => ({ inspectExact: mocks.inspect }),
}));
vi.mock("@/lib/ipc/dureWorkflow", () => ({
	createDureWorkflowTransport: () => ({
		ensureCoordinatorBinding: mocks.ensure,
	}),
}));
vi.mock("@/lib/ipc/dureBackend", async (original) => ({
	...(await original<object>()),
	resolveSelectedDureBackendRouteAuthority: mocks.selectRoute,
}));
vi.mock("@/lib/workspace/dock", () => ({ resolvePaneById: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {} }));
vi.mock("@/lib/workspace/window/durableStoreBroadcast", () => ({
	publishDurableStoreChanged: async () => {},
}));

const agent = managedRehostAgentFixture(0);
const target = nativeResumeCreateFixture(2);
const source = { agentId: agent.id, backendProfileId: "local" };
const routeAuthority = testDureBackendRouteAuthority(
	"backend-local",
	"observed-generation",
);
const unmanaged = {
	state: "unmanaged" as const,
	agentId: agent.id,
	backend: routeAuthority.backend,
	backendProfileId: routeAuthority.profileId,
	routeAuthority,
};
const lineage = {
	schema: "hmux-managed-rehost-resolution-v1",
	schemaVersion: 1,
	state: "resolved",
	operationIds: ["rehost-operation-1", "rehost-operation-2"],
	sourceGeneration: {
		sessionId: agent.sessionId,
		workspaceId: agent.runtimeBinding!.workspaceId,
		...nativeResumeCreateFixture(0).session.stopFence,
	},
	currentGeneration: {
		sessionId: target.session.sessionId,
		workspaceId: target.session.workspaceId,
		...target.session.stopFence,
	},
	providerId: "codex",
	permissionMode: "default",
	launchIdentity: { conversationId: agent.conversationId },
};
const writer = {
	session: { ...target.session, inputAllowed: true },
	idempotencyKey: target.idempotencyKey,
	conversationId: agent.conversationId,
	permissionMode: "default",
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.resolve.mockResolvedValue(lineage);
	mocks.writer.mockResolvedValue(writer);
	mocks.inspect.mockResolvedValue(unmanaged);
	useStore.setState({
		agents: [agent],
		accounts: [],
		layouts: {},
		projects: [
			{
				id: agent.projectId,
				name: "Project",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
	});
});

describe("unmanaged backend adoption of a completed Hmux successor", () => {
	it("commits only the final generation through the already observed backend route", async () => {
		await expect(
			convergeUnmanagedAgentSuccessor(source, unmanaged, () => true),
		).resolves.toBe(true);
		expect(mocks.ensure).toHaveBeenCalledExactlyOnceWith(
			routeAuthority,
			expect.objectContaining({
				agentId: agent.id,
				sessionId: target.session.sessionId,
				workspaceId: target.session.workspaceId,
				stopFence: target.session.stopFence,
			}),
		);
		expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(
			agent.id,
			routeAuthority,
		);
		expect(mocks.selectRoute).not.toHaveBeenCalled();
		expect(mocks.resolve).toHaveBeenCalledTimes(2);
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: target.session.sessionId,
			conversationId: agent.conversationId,
			runtimeBinding: { stopFence: target.session.stopFence },
		});
	});

	it.each(["not_found", "retry_required"])(
		"does not execute %s lineage",
		async (state) => {
			mocks.resolve.mockResolvedValue({
				...lineage,
				state,
				source: {
					sessionId: agent.sessionId,
					workspaceId: target.session.workspaceId,
				},
				operationId: "pending-operation",
			});
			await expect(
				convergeUnmanagedAgentSuccessor(source, unmanaged, () => true),
			).resolves.toBe(state === "not_found");
			expect(mocks.writer).not.toHaveBeenCalled();
			expect(mocks.ensure).not.toHaveBeenCalled();
			expect(useStore.getState().agents[0]).toBe(agent);
		},
	);

	it("preserves unavailable lineage and adopts the same target on the next observation", async () => {
		const failure = new Error("hmux_descriptor_unavailable");
		mocks.resolve.mockRejectedValueOnce(failure);
		await expect(
			convergeUnmanagedAgentSuccessor(source, unmanaged, () => true),
		).rejects.toBe(failure);
		expect(mocks.ensure).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toBe(agent);
		await expect(
			convergeUnmanagedAgentSuccessor(source, unmanaged, () => true),
		).resolves.toBe(true);
		expect(mocks.ensure).toHaveBeenCalledExactlyOnceWith(
			routeAuthority,
			expect.objectContaining({ sessionId: target.session.sessionId }),
		);
	});

	it("does not publish after the pane source changes during final writer inspection", async () => {
		const selected = managedRehostAgentFixture(3);
		mocks.writer.mockImplementation(async () => {
			useStore.setState({ agents: [selected] });
			return writer;
		});
		await expect(
			convergeUnmanagedAgentSuccessor(
				source,
				unmanaged,
				() => useStore.getState().agents[0] === agent,
			),
		).resolves.toBe(false);
		expect(mocks.ensure).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toBe(selected);
	});

	it("does not retarget a changed backend authority", async () => {
		const failure = new Error("client_backend_authority_changed");
		mocks.inspect.mockRejectedValue(failure);
		await expect(
			convergeUnmanagedAgentSuccessor(source, unmanaged, () => true),
		).rejects.toBe(failure);
		expect(mocks.ensure).not.toHaveBeenCalled();
		expect(mocks.selectRoute).not.toHaveBeenCalled();
		expect(mocks.inspect).toHaveBeenCalledWith(agent.id, routeAuthority);
	});

	it("refuses a lineage that advances during final writer inspection", async () => {
		mocks.resolve.mockResolvedValueOnce(lineage).mockResolvedValue({
			...lineage,
			operationIds: [...lineage.operationIds, "rehost-operation-3"],
		});
		await expect(
			convergeUnmanagedAgentSuccessor(source, unmanaged, () => true),
		).rejects.toThrow("lineage changed");
		expect(mocks.ensure).not.toHaveBeenCalled();
	});
});
