// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNamedPaneAction } from "@/components/workspace/useNamedPaneAction";
import { usePaneActions } from "@/components/workspace/usePaneActions";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { startCliServer } from "@/lib/cli/cliServer";
import { useUnopenedAgentVisibilityStore } from "@/lib/spaces/unopenedAgentVisibilityStore";
import { paneActionSnapshot } from "@/lib/workspace/pane/paneActionRegistry";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";

const mocks = vi.hoisted(() => ({
	listeners: new Map<
		string,
		(event: { event: string; id: number; payload: unknown }) => unknown
	>(),
	claim: vi.fn(),
	complete: vi.fn(),
}));
vi.mock("@/lib/platform/tauriBridge", async (original) => ({
	...(await original<typeof import("@/lib/platform/tauriBridge")>()),
	listenWhenReady: async (
		name: string,
		callback: (event: {
			event: string;
			id: number;
			payload: unknown;
		}) => unknown,
	) => {
		mocks.listeners.set(name, callback);
		return () => {
			mocks.listeners.delete(name);
		};
	},
}));
vi.mock("@tauri-apps/api/webviewWindow", async (original) => ({
	...(await original<typeof import("@tauri-apps/api/webviewWindow")>()),
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("@/lib/cli/cliServerObservers", () => ({
	startCliServerObservers: async () => () => {},
}));
vi.mock("@/lib/cli/cliRequestBroker", () => ({
	claimCliRequest: mocks.claim,
	completeCliRequest: mocks.complete,
}));
vi.mock("@/lib/cli/cliPaneDiagnostics", () => ({
	readCliPaneDiagnostics: (paneId: string) => ({ inspectedPaneId: paneId }),
}));

const stops: Array<() => void> = [];
beforeEach(() => {
	mocks.listeners.clear();
	mocks.claim.mockReset().mockResolvedValue(true);
	mocks.complete.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
	cleanup();
	for (const stop of stops.splice(0)) stop();
	expect(mocks.listeners.has("cli:request")).toBe(false);
	expect(mocks.listeners.has("dure://pane-owner/request")).toBe(false);
});

function Recipient({
	paneId,
	owner,
	run,
}: {
	paneId: string;
	owner: string;
	run: () => Promise<void>;
}) {
	usePaneActions(owner, { paneId, status: "attached", actions: {} });
	useNamedPaneAction(paneId, "recovery.fresh", true, run, owner);
	return null;
}

it("routes unopened visibility through the installed CLI listener to the UI store", async () => {
	const before = useStore.getState();
	const visibility = useUnopenedAgentVisibilityStore.getState().hidden;
	const agent = managedAgentFixture({ id: "unopened-cli-listener" });
	try {
		useStore.setState({ agents: [agent], layouts: {} });
		stops.push(await startCliServer());
		await mocks.listeners.get("cli:request")!({
			event: "cli:request",
			id: 1,
			payload: {
				reqId: "unopened-listener",
				action: "agents.unopened.visibility",
				params: {
					schemaVersion: 1,
					operation: "hide",
					agentId: agent.id,
					expectedEpisode: useAgentAttention.getState().episodes[agent.id] ?? 0,
				},
			},
		});
		expect(mocks.claim).toHaveBeenCalledExactlyOnceWith("unopened-listener");
		expect(mocks.complete).toHaveBeenCalledWith(
			"unopened-listener",
			expect.objectContaining({
				ok: true,
				visibility: expect.objectContaining({
					agentId: agent.id,
					hidden: true,
					persisted: true,
				}),
			}),
			"agents.unopened.visibility",
		);
		expect(
			useUnopenedAgentVisibilityStore
				.getState()
				.hidden.some((record) => record.id === agent.id),
		).toBe(true);
		expect(useStore.getState().agents).toEqual([agent]);
	} finally {
		useStore.setState({ agents: before.agents, layouts: before.layouts });
		useUnopenedAgentVisibilityStore.setState({ hidden: visibility });
	}
});

it("uses the selected claim boundary without installing a competing listener", async () => {
	const original = vi.fn(async () => {});
	const replacement = vi.fn(async () => {});
	const paneId = "pane-native-claim-boundary";
	const mounted = render(
		<Recipient paneId={paneId} owner="original" run={original} />,
	);
	const claim = vi.fn(async (reqId: string) => {
		const admitted = await mocks.claim(reqId);
		if (admitted)
			mounted.rerender(
				<Recipient paneId={paneId} owner="replacement" run={replacement} />,
			);
		return admitted;
	});
	stops.push(await startCliServer(claim));
	await mocks.listeners.get("cli:request")!({
		event: "cli:request",
		id: 1,
		payload: {
			reqId: "native-claim-boundary",
			action: "pane.act",
			params: { targetPanelId: paneId, actionId: "recovery.fresh" },
		},
	});
	expect(original).not.toHaveBeenCalled();
	expect(replacement).not.toHaveBeenCalled();
	expect(claim).toHaveBeenCalledExactlyOnceWith("native-claim-boundary");
	expect(mocks.claim).toHaveBeenCalledExactlyOnceWith("native-claim-boundary");
	expect(mocks.complete).toHaveBeenCalledWith(
		"native-claim-boundary",
		expect.objectContaining({
			ok: false,
			error: expect.objectContaining({ code: "pane_changed" }),
		}),
		"pane.act",
	);
});

async function entryRequest(paneId: string) {
	expect(paneActionSnapshot(paneId)?.actions).toContain("recovery.fresh");
	stops.push(await startCliServer());
	let release!: (value: boolean) => void;
	let entered!: () => void;
	const claimed = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const admission = new Promise<boolean>((resolve) => {
		release = resolve;
	});
	mocks.claim.mockImplementationOnce(() => {
		entered();
		return admission;
	});
	const listener = mocks.listeners.get("cli:request");
	expect(listener).toBeDefined();
	const event = {
		event: "cli:request",
		id: 1,
		payload: {
			reqId: "queued-pane-command",
			action: "pane.act",
			params: { targetPanelId: paneId, actionId: "recovery.fresh" },
		},
	};
	const finished = listener!(event);
	await claimed;
	return { release, finished, listener: listener!, event };
}

for (const paneId of ["pane-entry-stable", "agent:historical-entry"]) {
	it(`keeps the original recipient across the actual CLI listener for ${paneId}`, async () => {
		const original = vi.fn(async () => {});
		const replacement = vi.fn(async () => {});
		const mounted = render(
			<Recipient paneId={paneId} owner="original-runtime" run={original} />,
		);
		const request = await entryRequest(paneId);
		mounted.rerender(
			<Recipient
				paneId={paneId}
				owner="replacement-runtime"
				run={replacement}
			/>,
		);
		await act(async () => {
			request.release(true);
			await request.finished;
		});
		expect(original).not.toHaveBeenCalled();
		expect(replacement).not.toHaveBeenCalled();
		expect(mocks.complete).toHaveBeenCalledWith(
			"queued-pane-command",
			expect.objectContaining({
				ok: false,
				error: expect.objectContaining({
					code: "pane_changed",
					retryable: false,
				}),
			}),
			"pane.act",
		);
	});

	it(`accepts a committed callback refresh for the same recipient in ${paneId}`, async () => {
		const original = vi.fn(async () => {});
		const refreshed = vi.fn(async () => {});
		const mounted = render(
			<Recipient paneId={paneId} owner="same-runtime" run={original} />,
		);
		const request = await entryRequest(paneId);
		mounted.rerender(
			<Recipient paneId={paneId} owner="same-runtime" run={refreshed} />,
		);
		await act(async () => {
			request.release(true);
			await request.finished;
		});
		expect(original).not.toHaveBeenCalled();
		expect(refreshed).toHaveBeenCalledOnce();
		expect(mocks.complete).toHaveBeenCalledWith(
			"queued-pane-command",
			expect.objectContaining({ ok: true }),
			"pane.act",
		);
		mocks.claim.mockResolvedValueOnce(false);
		await request.listener(request.event);
		expect(refreshed).toHaveBeenCalledOnce();
		expect(mocks.complete).toHaveBeenCalledOnce();
	});

	it(`refuses a remounted recipient even if its identity text returns in ${paneId}`, async () => {
		const original = vi.fn(async () => {});
		const mounted = render(
			<Recipient paneId={paneId} owner="same-runtime" run={original} />,
		);
		const request = await entryRequest(paneId);
		mounted.rerender(
			<Recipient paneId={paneId} owner="intermediate-runtime" run={original} />,
		);
		mounted.rerender(
			<Recipient paneId={paneId} owner="same-runtime" run={original} />,
		);
		await act(async () => {
			request.release(true);
			await request.finished;
		});
		expect(original).not.toHaveBeenCalled();
		expect(mocks.complete).toHaveBeenCalledWith(
			"queued-pane-command",
			expect.objectContaining({
				ok: false,
				error: expect.objectContaining({
					code: "pane_changed",
					retryable: false,
				}),
			}),
			"pane.act",
		);
	});
}
