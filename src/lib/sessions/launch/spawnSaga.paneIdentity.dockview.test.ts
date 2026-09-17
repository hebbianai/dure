// @vitest-environment jsdom
import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnJournal } from "@/lib/ipc";
import { asRecord } from "@/lib/payloadGuards";
import { runSpawnSagaFromCli } from "@/lib/sessions/launch/spawnSaga";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { hidePaneWithRecord } from "@/lib/workspace/pane/paneHideActions";
import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";

const mocks = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock("@/lib/sessions/launch/managedRuntimeEnsure", () => ({
	beginManagedRuntimeEnsure: () => ({
		source: "local",
		receipt: mocks.ensure(),
	}),
}));

const fixtures: {
	api: DockviewApi;
	desktopId: string;
	element: HTMLElement;
}[] = [];
const initialState = useStore.getState();
const initialHidden = useHiddenPanes.getState().hidden;
const agent = agentFixture({
	id: "existing-agent",
	name: "existing-agent",
	projectId: "project",
	worktreePath: "/fixture/repo",
	runtimeBinding: managedBindingFixture({
		sessionId: "runtime",
		workspaceId: "workspace",
	}),
});
let sequence = 0;

beforeEach(() => {
	mocks.ensure
		.mockReset()
		.mockRejectedValue(new Error("injected ensure failure"));
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const { api, desktopId, element } of fixtures.splice(0)) {
		unregisterDockview(desktopId, api);
		api.dispose();
		element.remove();
	}
	useStore.setState(initialState);
	useHiddenPanes.setState({ hidden: initialHidden });
});

function setup() {
	const desktopId = `spawn-pane-${++sequence}`;
	const receiptId = `receipt-${desktopId}`;
	const element = document.createElement("div");
	document.body.append(element);
	const api = createDockview(element, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(1000, 700);
	registerDockview(desktopId, api);
	fixtures.push({ api, desktopId, element });
	useHiddenPanes.setState({ hidden: {} });
	useStore.setState({
		agents: [agent],
		projects: [
			{
				id: "project",
				name: "fixture",
				kind: "local",
				path: "/fixture/repo",
				isRepo: true,
			},
		],
		spaces: [{ id: desktopId, name: "Fixture" }],
		activeSpaceId: desktopId,
		layouts: {},
	});
	vi.spyOn(spawnJournal, "receipt").mockResolvedValue({
		v: 1,
		receiptId,
		request: {
			receiptId,
			project: "project",
			name: agent.name,
			provider: agent.provider,
			useWorktree: false,
			spaceId: desktopId,
		},
		steps: [],
		state: "running",
		updatedAt: 1,
	});
	const append = vi
		.spyOn(spawnJournal, "append")
		.mockResolvedValue(undefined as never);
	const peer = api.addPanel({ id: "peer", component: "launcher" });
	const run = () => runSpawnSagaFromCli({ receiptId });
	return { api, desktopId, peer, append, receiptId, run };
}

describe("spawn optional view ownership", () => {
	it("compensates only a new view while preserving its adopted Agent", async () => {
		const fixture = setup();
		await fixture.run();
		expect(mocks.ensure).toHaveBeenCalledOnce();
		expect(fixture.api.panels).toEqual([fixture.peer]);
		expect(fixture.api.toJSON()).toEqual(
			useStore.getState().layouts[fixture.desktopId],
		);
		expect(useStore.getState().agents).toEqual([agent]);
		const artifactEvent = fixture.append.mock.calls.find(
			([, event]) =>
				event.event === "artifact_created" &&
				asRecord(event.artifact)?.kind === "pane",
		)?.[1];
		expect(artifactEvent?.artifact).toEqual({
			kind: "pane",
			id: expect.any(String),
			desktopId: fixture.desktopId,
			agentId: agent.id,
		});
	});

	it("reconciles an unacknowledged pane journal write by adopting the same view", async () => {
		const fixture = setup();
		let lostWrite = false;
		fixture.append.mockImplementation(async (_receiptId, event) => {
			if (
				!lostWrite &&
				event.event === "artifact_created" &&
				asRecord(event.artifact)?.kind === "pane"
			) {
				lostWrite = true;
				throw new Error("injected journal acknowledgement loss");
			}
			return undefined as never;
		});
		await fixture.run();
		expect(lostWrite).toBe(true);
		expect(mocks.ensure).not.toHaveBeenCalled();
		const pendingView = fixture.api.panels.find(
			(panel) => panel.api.component === "agent",
		)!;
		expect(pendingView).toBeDefined();
		await fixture.run();
		expect(mocks.ensure).toHaveBeenCalledOnce();
		expect(fixture.api.getPanel(pendingView.id)).toBe(pendingView);
		expect(fixture.api.getPanel(fixture.peer.id)).toBe(fixture.peer);
		expect(fixture.api.panels).toHaveLength(2);
	});

	it("coalesces concurrent dispatch of the same receipt without replacing its view", async () => {
		const fixture = setup();
		const source = fixture.api.addPanel({
			id: "slot",
			component: "agent",
			params: { agentRef: { agentId: agent.id } },
		});
		let rejectEnsure!: (error: Error) => void;
		mocks.ensure.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectEnsure = reject;
				}),
		);
		const first = fixture.run();
		await vi.waitFor(() => expect(mocks.ensure).toHaveBeenCalledOnce());
		await fixture.run();
		expect(mocks.ensure).toHaveBeenCalledOnce();
		rejectEnsure(new Error("injected ensure failure"));
		await first;
		expect(fixture.api.getPanel(source.id)).toBe(source);
		expect(fixture.api.panels).toHaveLength(2);
	});

	it.each(["slot", "agent:previous", "launcher:previous"])(
		"adopts rather than compensates the existing view %s",
		async (panelId) => {
			const fixture = setup();
			const source = fixture.api.addPanel({
				id: panelId,
				component: "agent",
				params: { agentRef: { agentId: agent.id } },
			});
			await fixture.run();
			expect(mocks.ensure).toHaveBeenCalledOnce();
			expect(fixture.api.getPanel(panelId)).toBe(source);
			expect(fixture.api.getPanel(fixture.peer.id)).toBe(fixture.peer);
			expect(useStore.getState().agents).toEqual([agent]);
			expect(fixture.append).toHaveBeenCalledWith(
				fixture.receiptId,
				expect.objectContaining({
					event: "artifact_adopted",
					artifact: {
						kind: "pane",
						id: panelId,
						desktopId: fixture.desktopId,
						agentId: agent.id,
					},
				}),
			);
		},
	);

	it("restores a hidden user's pane without claiming creation ownership", async () => {
		const fixture = setup();
		fixture.api.addPanel({
			id: "hidden-slot",
			component: "agent",
			params: { agentRef: { agentId: agent.id } },
		});
		hidePaneWithRecord({
			desktopId: fixture.desktopId,
			panelId: "hidden-slot",
			agentId: agent.id,
		});
		expect(fixture.api.getPanel("hidden-slot")).toBeUndefined();
		await fixture.run();
		expect(fixture.api.getPanel("hidden-slot")?.params).toMatchObject({
			agentRef: { agentId: agent.id },
		});
		expect(fixture.append).toHaveBeenCalledWith(
			fixture.receiptId,
			expect.objectContaining({
				event: "artifact_adopted",
				artifact: {
					kind: "pane",
					id: "hidden-slot",
					desktopId: fixture.desktopId,
					agentId: agent.id,
				},
			}),
		);
	});

	it.each(["replace", "retarget", "reopen", "close"] as const)(
		"does not compensate newer work after %s while runtime ensure is pending",
		async (change) => {
			const fixture = setup();
			let targetId = "";
			let changed: ReturnType<DockviewApi["getPanel"]>;
			mocks.ensure.mockImplementationOnce(async () => {
				const source = fixture.api.panels.find(
					(panel) => panel.api.component === "agent",
				)!;
				targetId = source.id;
				if (change === "replace")
					fixture.api.replacePanel(source.api, {
						component: "launcher",
						params: { cwd: "/new-work" },
					});
				else if (change === "retarget")
					source.api.updateParameters({ agentRef: { agentId: "new-target" } });
				else {
					fixture.api.removePanel(source);
					if (change === "reopen")
						fixture.api.addPanel({ id: targetId, component: "launcher" });
				}
				changed = fixture.api.getPanel(targetId);
				useStore.getState().saveLayout(fixture.desktopId, fixture.api.toJSON());
				throw new Error("injected ensure failure");
			});
			await fixture.run();
			expect(mocks.ensure).toHaveBeenCalledOnce();
			expect(fixture.api.getPanel(targetId)).toBe(changed);
			expect(fixture.api.getPanel(fixture.peer.id)).toBe(fixture.peer);
			expect(fixture.api.toJSON()).toEqual(
				useStore.getState().layouts[fixture.desktopId],
			);
			expect(useStore.getState().agents).toEqual([agent]);
		},
	);
});
