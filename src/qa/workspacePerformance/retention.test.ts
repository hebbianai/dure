// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { hmux } from "@/lib/ipc";
import {
	assertRetentionSurfacesReleased,
	createWorkspaceRetentionSessions,
	runWorkspaceRetention,
} from "./retention";
import { workspacePerformanceScenario } from "./scenario";

const fixture = vi.hoisted(() => ({
	activeSpaceId: "a",
	totals: { terminalSurfaces: 2, hmuxObservers: 2, webglContexts: 0 },
	panels: new Map<string, { group: { element: HTMLElement } }>(),
}));
vi.mock("@/store", () => ({ useStore: { getState: () => fixture } }));
vi.mock("@/lib/workspace/dock/dockRegistry", () => ({
	waitForDesktopDockview: async () => undefined,
	getDockview: () => ({ getPanel: (id: string) => fixture.panels.get(id) }),
}));
vi.mock("@/lib/workspace/performance/workspacePerformance", () => ({
	getWorkspacePerformanceSnapshot: () => ({ totals: { ...fixture.totals } }),
}));

const topology = {
	spaces: [
		{ id: "a", name: "A" },
		{ id: "b", name: "B" },
	],
	activeSpaceId: "a",
	panelIdsByDesktop: { a: ["a-pane"], b: ["b-pane"] },
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("crypto", {
		subtle: {
			digest: async (_algorithm: string, bytes: Uint8Array) =>
				new Uint8Array(createHash("sha256").update(bytes).digest()).buffer,
		},
	});
	fixture.activeSpaceId = "a";
	fixture.totals = { terminalSurfaces: 2, hmuxObservers: 2, webglContexts: 0 };
	window.__DURE_WORKSPACE_PERFORMANCE_QA__ = {
		state: "running",
		phase: "initial",
		focus: {
			documentFocused: false,
			documentVisibility: "visible",
			activeElement: null,
		},
	};
	for (const space of topology.spaces) {
		const tab = document.createElement("button");
		tab.id = `desktop-tab-${space.id}`;
		tab.onclick = () => {
			fixture.activeSpaceId = space.id;
		};
		document.body.append(tab);
		const element = document.createElement("div");
		element.innerHTML =
			'<div data-testid="structured-terminal-presentation" data-terminal-viewport-rows="24"><div data-testid="structured-terminal-viewport">fixed provider output</div></div>';
		fixture.panels.set(`${space.id}-pane`, { group: { element } });
	}
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.replaceChildren();
	fixture.panels.clear();
	delete window.__DURE_WORKSPACE_PERFORMANCE_QA__;
	window.history.replaceState(null, "", "/");
});

it("creates only managed shells and reuses exact idempotent lease cleanup", async () => {
	const stopFence = {
		runnerPrincipal: "qa",
		runnerInstance: "qa",
		channelEpoch: "1",
		hostInstanceId: "host",
		terminalEpoch: "1",
	};
	const createManagedShell = vi
		.fn<typeof hmux.createManagedShell>()
		.mockImplementation(async (request) => ({
			idempotencyKey: request.idempotencyKey,
			outcome: "created",
			session: {
				sessionId: request.sessionId,
				workspaceId: request.workspaceId,
				sessionClass: "managed",
				lifecycle: "ready",
				stopFence,
				terminalEpoch: "1",
				outputSeq: "0",
				capabilities: [],
			},
		}));
	const stopManaged = vi.fn<typeof hmux.stopManaged>();
	const lease = await createWorkspaceRetentionSessions(
		workspacePerformanceScenario("sash_2"),
		{ createManagedShell, stopManaged },
	);
	expect(lease.sessions).toHaveLength(2);
	for (const [request] of createManagedShell.mock.calls) {
		expect(request).not.toHaveProperty("providerId");
		expect(request).not.toHaveProperty("command");
	}
	await lease.release();
	await lease.release();
	expect(stopManaged).toHaveBeenCalledTimes(2);
	expect(stopManaged.mock.calls.every((call) => call[3] === stopFence)).toBe(
		true,
	);
});

it("returns to the same Space with unchanged content and no native focus request", async () => {
	const focus = vi.spyOn(window, "focus").mockImplementation(() => {
		throw new Error("native focus forbidden");
	});
	const run = runWorkspaceRetention(topology);
	await vi.runAllTimersAsync();
	await run;
	expect(focus).not.toHaveBeenCalled();
	const evidence = window.__DURE_WORKSPACE_PERFORMANCE_QA__?.retention;
	expect(evidence?.samples).toHaveLength(9);
	expect(
		new Set(evidence?.samples.map((sample) => sample.activeSpaceId)),
	).toEqual(new Set(["a"]));
	expect(
		new Set(
			evidence?.samples.map((sample) => JSON.stringify(sample.contentHashes)),
		).size,
	).toBe(1);
});

it("waits for the initial React commit before navigating Space tabs", async () => {
	const tab = document.getElementById("desktop-tab-a")!;
	tab.remove();
	const run = runWorkspaceRetention(topology);
	setTimeout(() => document.body.append(tab), 100);
	await vi.runAllTimersAsync();
	await run;
	expect(
		window.__DURE_WORKSPACE_PERFORMANCE_QA__?.retention?.samples,
	).toHaveLength(9);
});

it("keeps the same panes idle for five minutes after extended cycling", async () => {
	window.history.replaceState(null, "", "?retention=extended");
	const clicks: number[] = [];
	for (const space of topology.spaces) {
		document
			.getElementById(`desktop-tab-${space.id}`)!
			.addEventListener("click", () => clicks.push(Date.now()));
	}
	const run = runWorkspaceRetention(topology);
	await vi.runAllTimersAsync();
	await run;
	const samples = window.__DURE_WORKSPACE_PERFORMANCE_QA__!.retention!.samples;
	expect(samples).toHaveLength(67);
	const idle = samples.slice(61);
	expect(idle.map((sample) => sample.phase)).toEqual(Array(6).fill("idle"));
	expect(idle[idle.length - 1].atMs - idle[0].atMs).toBeGreaterThanOrEqual(
		300_000,
	);
	expect(clicks.every((atMs) => atMs < idle[0].atMs)).toBe(true);
	expect(
		new Set(samples.map((sample) => JSON.stringify(sample.contentHashes))).size,
	).toBe(1);
});

it("rejects a changed workload instead of comparing unlike return samples", async () => {
	let visits = 0;
	document.getElementById("desktop-tab-b")!.onclick = () => {
		fixture.activeSpaceId = "b";
		if (++visits === 3) {
			fixture.panels
				.get("a-pane")!
				.group.element.querySelector(
					"[data-testid=structured-terminal-viewport]",
				)!.textContent = "changed provider output";
		}
	};
	const check = expect(runWorkspaceRetention(topology)).rejects.toThrow(
		"fixed-content precondition changed",
	);
	await vi.runAllTimersAsync();
	await check;
});

it("fails when observer retirement never arrives", async () => {
	const check = expect(assertRetentionSurfacesReleased()).rejects.toThrow(
		"resources survived pane removal",
	);
	await vi.runAllTimersAsync();
	await check;
});

it("waits for actual observer retirement instead of reporting pane removal as release", async () => {
	window.__DURE_WORKSPACE_PERFORMANCE_QA__!.retention = {
		workload: "managed-shell-fake-tui",
		profile: "short",
		expectedSamples: 9,
		samples: [],
	};
	let done = false;
	const run = assertRetentionSurfacesReleased().then(() => {
		done = true;
	});
	await vi.advanceTimersByTimeAsync(500);
	expect(done).toBe(false);
	fixture.totals = { terminalSurfaces: 0, hmuxObservers: 1, webglContexts: 0 };
	await vi.advanceTimersByTimeAsync(500);
	expect(done).toBe(false);
	fixture.totals.hmuxObservers = 0;
	await vi.advanceTimersByTimeAsync(50);
	await run;
	expect(
		window.__DURE_WORKSPACE_PERFORMANCE_QA__?.retention?.released,
	).toMatchObject({ terminalSurfaces: 0, hmuxObservers: 0 });
});
